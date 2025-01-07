import { Blockchain, SandboxContract, TreasuryContract, internal, prettyLogTransactions, BlockchainSnapshot, BlockchainTransaction, SendMessageResult } from '@ton/sandbox';
import { beginCell, Cell, toNano, internal as internal_relaxed, Address, SendMode, Dictionary } from '@ton/core';
import { Action, Multisig, MultisigConfig, TransferRequest, UpdateRequest } from '../wrappers/Multisig';
import { Order } from '../wrappers/Order';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress, findTransactionRequired, findTransaction} from '@ton/test-utils';
import { Op, Errors, Params } from '../wrappers/Constants';
import { getRandomInt, differentAddress, Txiterator, executeTill, executeFrom} from './utils';
import { getMsgPrices, computedGeneric } from '../gasUtils';

describe('Multisig', () => {
    let code: Cell;

    let blockchain: Blockchain;
    let multisig: SandboxContract<Multisig>;
    let deployer : SandboxContract<TreasuryContract>;
    let proposer : SandboxContract<TreasuryContract>;
    let signers  : Address[];
    let testMsg : TransferRequest;
    let testAddr : Address;
    let initialState: BlockchainSnapshot;

    let curTime : () => number;

    let getExpirationTime: (timeAfterUnlockSeconds: number) => number;
    let increaseTime: (seconds: number) => void;
    let approveLastOrder: (signers: SandboxContract<TreasuryContract>[]) => Promise<SendMessageResult[]>;

    const TIMELOCK_DELAY = 24 * 60 * 60;

    beforeAll(async () => {
        code = await compile('Multisig');
        blockchain = await Blockchain.create();
        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1_000);

        blockchain.now = curTime();

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        let order_code_raw = await compile('Order');
        _libs.set(BigInt(`0x${order_code_raw.hash().toString('hex')}`), order_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;

        deployer = await blockchain.treasury('deployer');
        proposer = await blockchain.treasury('proposer');
        signers  = [deployer, ...await blockchain.createWallets(4)].map(s => s.address);

        let config = {
            threshold: 1,
            signers,
            proposers: [proposer.address],
            allowArbitrarySeqno: false,
            timelockDelaySeconds: TIMELOCK_DELAY,
        };

        testAddr = randomAddress();
        testMsg = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};

        multisig = blockchain.openContract(Multisig.createFromConfig(config, code));
        const deployResult = await multisig.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            deploy: true,
            success: true,
        });

        initialState = blockchain.snapshot();

        getExpirationTime = (timeAfterUnlockSeconds: number) => curTime() + TIMELOCK_DELAY + timeAfterUnlockSeconds;
        increaseTime = (seconds: number) => blockchain.now! += seconds;

        approveLastOrder = async (signers: SandboxContract<TreasuryContract>[]) => {
            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno - 1n);
            const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
            const txs: SendMessageResult[] = [];

            let signerIndex = 0;
            for (let signer of signers) {
                txs.push(await orderContract.sendApprove(signer.getSender(), signerIndex));
                signerIndex++;
            }
            return txs;
        };
    });
    // Each case state is independent
    afterEach(async () => await blockchain.loadFrom(initialState));

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and Multisig are ready to use
    });
    it('only signers and proposers should be able to create order', async () => {
        const nobody   = await blockchain.treasury('nobody');


        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        blockchain.now = Math.floor(Date.now() / 1000)
        const msgSigner= Multisig.newOrderMessage([testMsg],  blockchain.now + TIMELOCK_DELAY + 10,
                                                         true, // is signer
                                                         0, // Address index
                                                        );
        // Make sure proposers a checked against list too
        const msgProp  = Multisig.newOrderMessage([testMsg],  blockchain.now + TIMELOCK_DELAY + 10,
                                                         false, // is signer
                                                         0, // Address index
                                                        );

        let assertUnauthorizedOrder= (txs: BlockchainTransaction[], from: Address) => {
            expect(txs).toHaveTransaction({
                from,
                to: multisig.address,
                success: false,
                aborted: true,
                exitCode: Errors.multisig.unauthorized_new_order
            });
            expect(txs).not.toHaveTransaction({
                from: multisig.address,
                to: orderAddress,
                deploy: true
            });
        }
        let nobodyMsgs = [msgSigner, msgProp];
        for (let nbMessage of nobodyMsgs) {
            let res = await blockchain.sendMessage(internal({
                from: nobody.address,
                to: multisig.address,
                body: nbMessage,
                value: toNano('1')
            }));

            assertUnauthorizedOrder(res.transactions, nobody.address);
        }

        // Sending from valid proposer address should result in order creation
        let res = await blockchain.sendMessage(internal({
            from: proposer.address,
            to: multisig.address,
            body: msgProp,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : proposer.address,
            to: multisig.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // But should not trigger execution
        expect(res.transactions).not.toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute
        });

        // Order seqno should increase
        orderAddress = await multisig.getOrderAddress(initialSeqno + 1n);
        // Sending signer message from proposer should fail
        res = await blockchain.sendMessage(internal({
            from: proposer.address,
            to: multisig.address,
            body: msgSigner,
            value: toNano('1')
        }));
        assertUnauthorizedOrder(res.transactions, proposer.address);
        // Proposer message from signer should fail as well
        res = await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: msgProp,
            value: toNano('1')
        }));
        assertUnauthorizedOrder(res.transactions, deployer.address);
        // Now test signer
        res = await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: msgSigner,
            value: toNano('1')
        }));

        expect(res.transactions).toHaveTransaction({
            from : deployer.address,
            to: multisig.address,
            success: true
        });
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });
        // Now execution should trigger, since threshold is 1
        // expect(res.transactions).toHaveTransaction({
        //     from: orderAddress,
        //     to: multisig.address,
        //     op: Op.multisig.execute
        // });
    });
    it('order expiration time should exceed current time', async () => {

        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], curTime() - 100);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: false,
            aborted: true,
            exitCode: Errors.multisig.expired
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: orderAddress
        });
    });
    it('should reject order creation with insufficient incoming value', async () => {
        const year = 3600 * 24 * 365;

        const initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await multisig.getOrderAddress(initialSeqno);

        // Twice as low as we need
        const msgValue = (await multisig.getOrderEstimate([testMsg], BigInt(curTime() + year))) / 2n;

        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], curTime() + year, msgValue);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: false,
            aborted: true,
            exitCode: Errors.multisig.not_enough_ton
        });
        expect(res.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: orderAddress
        });
    });
    it('deployed order state should match requested', async () => {
        // Let's deploy multisig with randomized parameters

        const signersNum = getRandomInt(10, 20);
        const signers   = await blockchain.createWallets(signersNum);
        const proposers = await blockchain.createWallets(getRandomInt(10, 20));

        let config = {
            threshold: signersNum - getRandomInt(1, 5),
            signers: signers.map(s => s.address),
            proposers: proposers.map(p => p.address),
            allowArbitrarySeqno: false,
            timelockDelaySeconds: 24 * 60 * 60,
        };

        const testMultisig = blockchain.openContract(Multisig.createFromConfig(config, code));

        let res = await testMultisig.sendDeploy(signers[0].getSender(), toNano('1'));
        expect(res.transactions).toHaveTransaction({
            to: testMultisig.address,
            deploy: true,
            success: true
        });


        const initialSeqno = (await testMultisig.getMultisigData()).nextOrderSeqno;
        let   orderAddress = await testMultisig.getOrderAddress(initialSeqno);


        const rndBody = beginCell().storeUint(getRandomInt(100, 1000), 32).endCell();
        const rndMsg : TransferRequest = {type:"transfer", sendMode: 1, message: internal_relaxed({to: testAddr, value: toNano('0.015'), body: rndBody})};
        res = await testMultisig.sendNewOrder(signers[getRandomInt(0, signers.length - 1)].getSender(), [rndMsg], curTime() + TIMELOCK_DELAY + 100);
        expect(res.transactions).toHaveTransaction({
            from: testMultisig.address,
            to: orderAddress,
            deploy: true,
            success: true
        });

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const orderData = await orderContract.getOrderData();

        // console.log("Order signers:", orderData.signers);
        // console.log("Orig signers:", config.signers);

        const stringifyAddr = (a: Address) => a.toString();
        expect(orderData.multisig).toEqualAddress(testMultisig.address);
        expect(orderData.signers.map(stringifyAddr)).toEqual(config.signers.map(stringifyAddr));
        expect(orderData.executed).toBe(false);
        expect(orderData.threshold).toEqual(config.threshold);
        // expect(orderData.approvals_num).toBe(1);
    });
    it('should execute new message order', async () => {
        blockchain.now   = curTime();
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        // await blockchain.setVerbosityForAddress(multisig.address, {blockchainLogs:true, vmLogs: 'vm_logs'});
        const res = await multisig.sendNewOrder(deployer.getSender(), [testMsg], Math.floor(curTime() + TIMELOCK_DELAY + 100));

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });

        blockchain.now += TIMELOCK_DELAY;

        const order =  blockchain.openContract(Order.createFromAddress(orderAddress));
        const orderExecution = await order.sendApprove(deployer.getSender(), 0);
        // console.log(res1.transactions);

        // one signer and threshold is 1
        expect(orderExecution.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });
    it('expired order execution should be denied', async () => {
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        blockchain.now   = curTime();
        const deployRes  = await multisig.sendNewOrder(proposer.getSender(), [testMsg], blockchain.now + TIMELOCK_DELAY + 1);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(deployRes.transactions).toHaveTransaction({
            from: multisig.address,
            on: orderAddress,
            op: Op.order.init,
            deploy: true,
            success: true
        });
        // Some time passed after init
        blockchain.now+=(TIMELOCK_DELAY + 1);
        let txIter = new Txiterator(blockchain,internal({
                from: deployer.address,
                to: orderAddress,
                value: toNano('1'),
                body: beginCell().storeUint(Op.order.approve, Params.bitsize.op)
                                 .storeUint(0, Params.bitsize.queryId)
                                 .storeUint(0, Params.bitsize.signerIndex)
                                 .endCell()
        }));

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

        let txs = await executeTill(txIter,{
            from: orderAddress,
            on: deployer.address,
            op: Op.order.approved,
            success: true,
        });

        findTransactionRequired(txs, {
            from: deployer.address,
            on: orderAddress,
            op: Op.order.approve,
            success: true,
            outMessagesCount: 2 // Make sure both approval notification and exec message is produced
        });
        // Make sure exec transaction is not yet processed
        expect(findTransaction(txs, {
            from: orderAddress,
            on: multisig.address,
            op: Op.multisig.execute
        })).not.toBeDefined();
        // While message was in transit, some more time passed
        blockchain.now++;
        // Continue execution
        txs = await executeFrom(txIter);
        // Execute message was sent, but failed due to expire
        expect(txs).toHaveTransaction({
            from: orderAddress,
            on: multisig.address,
            op: Op.multisig.execute,
            success: false,
            aborted: true,
            exitCode: Errors.order.expired
        });
        expect((await orderContract.getOrderData()).executed).toBe(true);
        // Double check that order has not been executed.
        expect(txs).not.toHaveTransaction({
            from: multisig.address,
            on: testAddr,
            op: 12345
        });
    });
    it('should be possible to execute order by post init approval', async () => {
        // Same test as above, but with manual approval
        blockchain.now = curTime();
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        // Gets deployed by proposer, so first approval is not granted right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], TIMELOCK_DELAY + Math.floor(curTime() + 100));

        expect(res.transactions).toHaveTransaction({
            from: proposer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const dataBefore = await orderContract.getOrderData();

        expect(dataBefore.approvals_num).toBe(0);
        expect(dataBefore.executed).toBe(false);

        blockchain.now! += TIMELOCK_DELAY;

        // Here goes the approval
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });
        // one signer and threshold is 1
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.015'),
            body: testMsg.message.body
        });
    });

    it('order estimate should work', async () => {
        const testMsg: TransferRequest = {type: "transfer", sendMode: 1, message: internal_relaxed({to: randomAddress(), value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const hrEst = await multisig.getOrderEstimate([testMsg], BigInt(curTime() + 3600));
        console.log("Estimate for one hour:", hrEst);
        const yearEst = await multisig.getOrderEstimate([testMsg], BigInt(curTime() + 3600 * 24 * 365));
        console.log("Estimate for yearly storage:", yearEst);
        console.log("Storage delta:", yearEst - hrEst);
    });
    it('should send new order with many actions in specified order', async () => {
        const testAddr1 = randomAddress();
        const testAddr2 = randomAddress();
        const testMsg1: TransferRequest = { type: "transfer", sendMode: 1, message: internal_relaxed({to: testAddr1, value: toNano('0.015'), body: beginCell().storeUint(12345, 32).endCell()})};
        const testMsg2: TransferRequest = {type : "transfer", sendMode: 1, message: internal_relaxed({to: testAddr2, value: toNano('0.016'), body: beginCell().storeUint(12346, 32).endCell()})};
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        let res = await multisig.sendNewOrder(deployer.getSender(), [testMsg1, testMsg2], curTime() + TIMELOCK_DELAY + 1_000);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true,
            outMessagesCount: 1
        });
        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });

        blockchain.now! += TIMELOCK_DELAY;

        let orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        let executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        let order1Tx = findTransactionRequired(executeTx.transactions, {
            from: multisig.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        let order2Tx = findTransactionRequired(executeTx.transactions, {
            from: multisig.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });

        expect(order2Tx).not.toBeUndefined();
        expect(order2Tx!.lt).toBeGreaterThan(order1Tx!.lt);
        // Let's switch the order

        initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        res = await multisig.sendNewOrder(deployer.getSender(), [testMsg2, testMsg1], curTime() + TIMELOCK_DELAY + 1_000);

        blockchain.now! += TIMELOCK_DELAY;

        orderContract = blockchain.openContract(Order.createFromAddress(await multisig.getOrderAddress(initialSeqno)));
        executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        order1Tx = findTransactionRequired(executeTx.transactions, {
            from: multisig.address,
            to: testAddr1,
            value: toNano('0.015'),
            body: beginCell().storeUint(12345, 32).endCell(),
        });
        order2Tx = findTransactionRequired(executeTx.transactions, {
            from: multisig.address,
            to: testAddr2,
            value: toNano('0.016'),
            body: beginCell().storeUint(12346, 32).endCell(),
        });
        // Now second comes first
        expect(order2Tx!.lt).toBeLessThan(order1Tx!.lt);
    });
    it('should execute update multisig parameters correctly', async () => {
        const newSigners = await blockchain.createWallets(4);
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: 4,
            timelockDelaySeconds: Math.floor(TIMELOCK_DELAY / 2),
            signers: newSigners.map(s => s.address),
            proposers: []
        };
        let initialSeqno = (await multisig.getMultisigData()).nextOrderSeqno;
        //todo adjust for new order seqno behavior
        let res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], getExpirationTime(1_000));

        expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(initialSeqno + 1n);
        let orderAddress = await multisig.getOrderAddress(initialSeqno);
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddress,
            success: true
        });

        blockchain.now! += TIMELOCK_DELAY;
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        const executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        expect(executeTx.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });

        const dataAfter = await multisig.getMultisigData();
        expect(dataAfter.threshold).toEqual(BigInt(updOrder.threshold));
        expect(dataAfter.signers[0]).toEqualAddress(newSigners[0].address);
        expect(dataAfter.proposers.length).toBe(0);
        expect(dataAfter.timelockDelaySeconds).toEqual(BigInt(updOrder.timelockDelaySeconds));
    });
    it('should reject multisig parameters with inconsistently ordered signers or proposers', async () => {
        // To produce inconsistent dictionary we have to craft it manually
        const malformed = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        malformed.set(0, randomAddress());
        malformed.set(2, randomAddress());
        let updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                                    .storeUint(4, 8)
                                    .storeUint(TIMELOCK_DELAY, 32)
                                    .storeDict(malformed) // signers
                                    .storeDict(null) // empty proposers
                         .endCell();

        const orderDict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        orderDict.set(0, updateCell);

        let orderCell = beginCell().storeDictDirect(orderDict).endCell();

        let dataBefore   = await multisig.getMultisigData();
        let orderAddress = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        let res = await multisig.sendNewOrder(deployer.getSender(), orderCell, getExpirationTime(100));

        blockchain.now! += TIMELOCK_DELAY;
        let orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        let executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        expect(executeTx.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.invalid_dictionary_sequence
        });

        const stringify = (x: Address) => x.toString();
        let dataAfter = await multisig.getMultisigData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));

        dataBefore   = await multisig.getMultisigData();
        orderAddress = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);

        // Now let's test if proposers order is checked
        malformed.clear();
        // Let's be bit sneaky. It's kinda consistent, but starts with 1. Should fail anyways.
        malformed.set(1, randomAddress());
        malformed.set(2, randomAddress());

        updateCell = beginCell().storeUint(Op.actions.update_multisig_params, 32)
                                .storeUint(4, 8)
                                .storeUint(TIMELOCK_DELAY, 32)
                                .storeDict(null) // Empty signers? Yes, that is allowed
                                .storeDict(malformed) // proposers
                     .endCell();

        // All over again
        orderDict.set(0, updateCell);
        orderCell = beginCell().storeDictDirect(orderDict).endCell();

        orderContract = blockchain.openContract(Order.createFromAddress(
            await multisig.getOrderAddress(dataBefore.nextOrderSeqno)
        ));

        res = await multisig.sendNewOrder(deployer.getSender(), orderCell, getExpirationTime(100));

        blockchain.now! += TIMELOCK_DELAY;
        executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        expect(executeTx.transactions).toHaveTransaction({
            from: orderAddress,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.invalid_dictionary_sequence
        });

        dataAfter = await multisig.getMultisigData();
        // Order seqno should increase
        expect(dataAfter.nextOrderSeqno).toEqual(dataBefore.nextOrderSeqno + 1n);
        // Rest stay same
        expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        expect(dataAfter.signers.map(stringify)).toEqual(dataBefore.signers.map(stringify));
        expect(dataAfter.proposers.map(stringify)).toEqual(dataBefore.proposers.map(stringify));
    });
    it('should accept execute internal only from self address', async () => {
        const nobody = await blockchain.treasury('nobody');
        // Let's test every role
        const roles = [deployer, proposer, nobody];
        const testAddr  = randomAddress();
        const testReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: beginCell().storeUint(0x12345, 32).endCell()
            })
        };

        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(testReq));
        const testBody = beginCell().storeUint(Op.multisig.execute_internal, Params.bitsize.op)
                                    .storeUint(0, Params.bitsize.queryId)
                                    .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                         .endCell();

        for (let testWallet of roles) {
            let res = await blockchain.sendMessage(internal({
                from: testWallet.address,
                to: multisig.address,
                value: toNano('1'),
                body: testBody
            }));
            expect(res.transactions).toHaveTransaction({
                from: testWallet.address,
                to: multisig.address,
                op: Op.multisig.execute_internal,
                aborted: true
            });
            expect(res.transactions).not.toHaveTransaction({
                from: multisig.address,
                to: testAddr
            });
        }
    });
    it('chained execution should work', async () => {

        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();
        const chainedReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: testAddr,
                value: toNano('0.01'),
                body: testBody
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(chainedReq));
        const triggerReq: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multisig.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multisig.execute_internal, Params.bitsize.op)
                            .storeUint(0, Params.bitsize.queryId)
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell())
                  .endCell()
            })
        };
        const res = await multisig.sendNewOrder(deployer.getSender(), [triggerReq], getExpirationTime(1_000), toNano('1'));

        const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno - 1n);
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

        blockchain.now! += TIMELOCK_DELAY;
        const executeTx = await orderContract.sendApprove(deployer.getSender(), 0);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        // Self message
        expect(executeTx.transactions).toHaveTransaction({
            from: multisig.address,
            to: multisig.address,
            op: Op.multisig.execute_internal,
            success: true
        });
        // Chained message
        expect(executeTx.transactions).toHaveTransaction({
            from: multisig.address,
            to: testAddr,
            value: toNano('0.01'),
            body: testBody
        });
    });
    it('multisig should invalidate previous orders if signers change', async () => {
        const testAddr = randomAddress();
        const testBody = beginCell().storeUint(0x12345, 32).endCell();

        const dataBefore = await multisig.getMultisigData();
        const orderAddr    = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        const testMsg: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multisig.address,
                value: toNano('0.015'),
                body: testBody
            })
        };
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: Number(dataBefore.threshold),
            timelockDelaySeconds: TIMELOCK_DELAY,
            signers: [differentAddress(deployer.address)],
            proposers: dataBefore.proposers
        };

        // First we deploy order with proposer, so it doesn't execute right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], getExpirationTime(1_000));
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddr,
            deploy: true,
            success: true
        });
        // Now lets perform signers update
        res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], getExpirationTime(1_000));

        increaseTime(TIMELOCK_DELAY);
        await approveLastOrder([deployer]);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        expect((await multisig.getMultisigData()).signers[0]).not.toEqualAddress(dataBefore.signers[0]);

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddr));
        // Now let's approve old order
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddr,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.singers_outdated
        });
    });
    it('multisig should invalidate previous orders if threshold increased', async () => {
        const dataBefore = await multisig.getMultisigData();
        const orderAddr  = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
        const testBody = beginCell().storeUint(0x12345, 32).endCell();
        const testMsg: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multisig.address,
                value: toNano('0.015'),
                body: testBody
            })
        };
        const updOrder : UpdateRequest = {
            type: "update",
            threshold: Number(dataBefore.threshold) + 1, // threshold increases
            signers, // Doesn't change
            timelockDelaySeconds: TIMELOCK_DELAY,
            proposers: dataBefore.proposers
        };
        // First we deploy order with proposer, so it doesn't execute right away
        let res = await multisig.sendNewOrder(proposer.getSender(), [testMsg], getExpirationTime(1_000));
        expect(res.transactions).toHaveTransaction({
            from: multisig.address,
            to: orderAddr,
            deploy: true,
            success: true
        });
        // Now lets perform threshold update
        res = await multisig.sendNewOrder(deployer.getSender(), [updOrder], getExpirationTime(1_000));
        increaseTime(TIMELOCK_DELAY);
        await approveLastOrder([deployer]);

        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            to: multisig.address,
            success: true
        });
        expect((await multisig.getMultisigData()).threshold).toEqual(dataBefore.threshold + 1n);

        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddr));
        // Now let's approve old order
        res = await orderContract.sendApprove(deployer.getSender(), 0);
        expect(res.transactions).toHaveTransaction({
            from: orderAddr,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.singers_outdated
        });
    });
    it('multisig should not execute orders deployed by other multisig contract', async () => {
        const coolHacker = await blockchain.treasury('1337');
        const newConfig : MultisigConfig = {
            threshold: 1,
            signers: [coolHacker.address], // So deployment init is same except just one field (so still different address)
            proposers: [proposer.address],
            allowArbitrarySeqno : false,
            timelockDelaySeconds: 24 * 60 * 60,
        };

        const evilMultisig = blockchain.openContract(Multisig.createFromConfig(newConfig,code));

        const legitData = await multisig.getMultisigData();
        let res = await evilMultisig.sendDeploy(coolHacker.getSender(), toNano('10'));
        expect(res.transactions).toHaveTransaction({
            from: coolHacker.address,
            to: evilMultisig.address,
            deploy: true,
            success: true
        });
        const evilPayload: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: coolHacker.address,
                value: toNano('100000'), // Evil enough? Could have changed multisig params even
                body: beginCell().storeUint(1337, 32).endCell()
            })
        };
        const order_dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        order_dict.set(0, Multisig.packTransferRequest(evilPayload));

        const mock_signers = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
        // Copy the real signers
        for (let i = 0; i < legitData.signers.length; i++) {
            mock_signers.set(i, legitData.signers[i]);
        }
        const evalOrder: TransferRequest = {
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
            to: multisig.address,
            value: toNano('0.01'),
            body: beginCell().storeUint(Op.multisig.execute, Params.bitsize.op)
                            .storeUint(0, Params.bitsize.queryId)
                            .storeUint(legitData.nextOrderSeqno, Params.bitsize.orderSeqno)
                            .storeUint(0xffffffffffff, Params.bitsize.time)
                            .storeUint(0xffffffffffff, Params.bitsize.time)
                            .storeBit(false)
                            .storeUint(0xff, Params.bitsize.signerIndex)
                            .storeUint(BigInt('0x' + beginCell().storeDictDirect(mock_signers).endCell().hash().toString('hex')), 256) // pack legit hash
                            .storeRef(beginCell().storeDictDirect(order_dict).endCell()) // Finally eval payload
                  .endCell()
            })
        };

        res = await evilMultisig.sendNewOrder(coolHacker.getSender(), [evalOrder], getExpirationTime(100));
        const orderAddress = await evilMultisig.getOrderAddress(
            (await evilMultisig.getMultisigData()).nextOrderSeqno - 1n
        );
        const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));
        increaseTime(TIMELOCK_DELAY);
        const executeTx = await orderContract.sendApprove(coolHacker.getSender(), 0);

        expect(executeTx.transactions).toHaveTransaction({
            from: evilMultisig.address,
            to: multisig.address,
            op: Op.multisig.execute,
            aborted: true,
            success: false,
            exitCode: Errors.multisig.unauthorized_execute
        });
        // No funds exfiltrated
        expect(executeTx.transactions).not.toHaveTransaction({
            from: multisig.address,
            to: coolHacker.address
        });
    });
    it('should handle more than 255 orders', async () => {

        // Topping up
        await blockchain.sendMessage(internal({
            from: deployer.address,
            to: multisig.address,
            body: beginCell().storeUint(0, 32).storeUint(0, 64).endCell(),
            value: toNano('1000')
        }));
        const orderCount = getRandomInt(260, 500);

        console.log(`Charging ${orderCount} orders!`);
        const order : Array<Action> = Array(orderCount);

        for(let i = 0; i < orderCount; i++) {
            order[i] = {
                type: "transfer",
                sendMode: 1,
                message: internal_relaxed({
                    to: deployer.address,
                    value: toNano('0.01'),
                    body: beginCell().storeUint(i, 32).endCell()
                })
            };
        }

        console.log("Fire!");
        const res = await multisig.sendNewOrder(deployer.getSender(), order, getExpirationTime(100), toNano('100'));

        increaseTime(TIMELOCK_DELAY);
        const [executeTx] = await approveLastOrder([deployer]);

        expect(executeTx.transactions).toHaveTransaction({
            to: multisig.address,
            op: Op.multisig.execute,
            success: true
        });
        expect(executeTx.transactions).toHaveTransaction({
            to: multisig.address,
            op: Op.multisig.execute_internal
        });

        let prevLt = 0n;
        for(let i = 0; i < orderCount; i++) {
            // console.log("Testing tx:", i);
            const tx = findTransactionRequired(executeTx.transactions, {
                from: multisig.address,
                to: deployer.address,
                op: i,
            });
            // console.log("Got tx:i");
            expect(tx.lt).toBeGreaterThan(prevLt); // Check tx order
            prevLt = tx.lt;
        }
    });
    describe('Threshold = 0', () => {
        it.skip('should not deploy with threshold = 0', async () => {
            let newConfig = {
                threshold: 0,
                signers,
                proposers: [],
                allowArbitrarySeqno: false,
                timelockDelaySeconds: 24 * 60 * 60,
            };
            let stateBefore   = blockchain.snapshot();

            console.log("Creating multisig!");
            const newMultisig = blockchain.openContract(Multisig.createFromConfig(newConfig, code));
            const res = await newMultisig.sendDeploy(deployer.getSender(), toNano('1'));
            try {
                expect(res.transactions).toHaveTransaction({
                    on: newMultisig.address,
                    initData: (x) => {
                        const ds = x!.beginParse();
                        console.log("Seqno:", ds.loadUint(256));
                        const threshold = ds.loadUint(8);
                        console.log("New threshold:", threshold);
                        return threshold == 0;
                    }
                });
                expect(res.transactions).toHaveTransaction({
                    on: newMultisig.address,
                    from: deployer.address,
                    oldStatus: 'uninitialized',
                    aborted: true
                });
            }
            finally {
                await blockchain.loadFrom(stateBefore);
            }
        });
        it('multisig parameters update with threshold = 0 should fail', async () => {
            const dataBefore = await multisig.getMultisigData();
            const orderAddr  = await multisig.getOrderAddress(dataBefore.nextOrderSeqno);
            expect(dataBefore.threshold).not.toBe(0n);

            const updateReq : UpdateRequest = {
                'threshold': 0,
                'type': 'update',
                'signers': dataBefore.signers,
                'proposers': dataBefore.proposers,
                'timelockDelaySeconds': TIMELOCK_DELAY
            }

            const res = await multisig.sendNewOrder(deployer.getSender(), [updateReq, testMsg], getExpirationTime(1_000));
            increaseTime(TIMELOCK_DELAY);
            const [executeTx] = await approveLastOrder([deployer]);

            expect(executeTx.transactions).toHaveTransaction({
                on: multisig.address,
                from: orderAddr,
                op: Op.multisig.execute,
                aborted: true
            });
            // Make sure that the next action is not executed for whatever reason
            expect(executeTx.transactions).not.toHaveTransaction({
                on: testAddr,
                from: multisig.address
            });
            const dataAfter = await multisig.getMultisigData();
            expect(dataAfter.threshold).toEqual(dataBefore.threshold);
        });
    });
    describe('Arbitrary seqno', () => {
        describe('Not allowed', () => {
        it('should not allow to create order with seqno other then next order seqno', async () => {
            const multisigData = await multisig.getMultisigData();
            // Arbitrary seqno is not allowed
            expect(multisigData.nextOrderSeqno).not.toEqual(-1n);


            const orderAddress = await multisig.getOrderAddress(multisigData.nextOrderSeqno);
            let    res = await multisig.sendNewOrder(deployer.getSender(),[testMsg],
                                                    getExpirationTime(100), toNano('0.5'),
                                                    0, true, multisigData.nextOrderSeqno);

            expect(res.transactions).toHaveTransaction({
                on: multisig.address,
                from: deployer.address,
                op: Op.multisig.new_order,
                success: true,
            });
            expect(res.transactions).toHaveTransaction({
                on: orderAddress,
                from: multisig.address,
            });
            const dataAfter = await multisig.getMultisigData();
            const trySeqno = async (seqno: bigint) => {
                res = await multisig.sendNewOrder(deployer.getSender(),[testMsg],
                                                  getExpirationTime(100), toNano('0.5'),
                                                  0, true, seqno);
                expect(res.transactions).toHaveTransaction({
                    on: multisig.address,
                    from: deployer.address,
                    op: Op.multisig.new_order,
                    success: false,
                    aborted: true,
                    exitCode: Errors.multisig.invalid_new_order
                });
                expect(res.transactions).not.toHaveTransaction({
                    on: orderAddress
                });
                // Should not change
                expect((await multisig.getMultisigData()).nextOrderSeqno).toEqual(dataAfter.nextOrderSeqno);
            };
            // Now repeat with same seqno
            await trySeqno(multisigData.nextOrderSeqno);
            // Now with seqno higher than expected
            await trySeqno(multisigData.nextOrderSeqno + BigInt(getRandomInt(2, 1000)));
            // Now with seqno lower than expected
            await trySeqno(dataAfter.nextOrderSeqno - 1n);
        });
        });
        describe('Allowed', () => {
            let newMultisig: SandboxContract<Multisig>;
            let allowedState: BlockchainSnapshot;
            beforeAll(async () => {
                blockchain.now = Math.floor(Date.now() / 1000);
                let config = {
                    threshold: 4,
                    signers: signers,
                    proposers: [proposer.address],
                    allowArbitrarySeqno: true,
                    timelockDelaySeconds: 24 * 60 * 60,
                };
                newMultisig = blockchain.openContract(Multisig.createFromConfig(config, code));
                const deployResult = await newMultisig.sendDeploy(deployer.getSender(), toNano('1'));

                expect(deployResult.transactions).toHaveTransaction({
                    from: deployer.address,
                    to: newMultisig.address,
                    deploy: true,
                    success: true,
                });
                expect((await newMultisig.getMultisigData()).nextOrderSeqno).toEqual(-1n);
                allowedState = blockchain.snapshot();
            });
            beforeEach( async () => await blockchain.loadFrom(allowedState));
            it('should allow to create orders with arbitrary seqno', async () => {
                for(let i = 0; i < 5; i++) {
                    const newSeqno  = BigInt(getRandomInt(100, 20000));
                    const signerIdx = i % signers.length;
                    const orderAddr = await newMultisig.getOrderAddress(newSeqno);
                    let res = await newMultisig.sendNewOrder(blockchain.sender(signers[signerIdx]),
                                                          [testMsg], getExpirationTime(100),
                                                          toNano('0.5'), signerIdx,
                                                          true, newSeqno);
                    expect(res.transactions).toHaveTransaction({
                        on: newMultisig.address,
                        from: signers[signerIdx],
                        op: Op.multisig.new_order,
                        success: true
                    });
                    expect(res.transactions).toHaveTransaction({
                        on: orderAddr,
                        from: newMultisig.address,
                    });
                }
            });
            it('should allow to create order with maximum possible seqno', async () => {
                const maxSeqno = (2n ** 256n) - 1n;
                const maxOrderSeqno = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
                // Just in case
                expect(maxSeqno).toEqual(maxOrderSeqno);
                let orderAddress = await newMultisig.getOrderAddress(maxSeqno);
                let res = await newMultisig.sendNewOrder(deployer.getSender(),
                                                      [testMsg], getExpirationTime(100),
                                                      toNano('0.5'), 0,
                                                      true, maxSeqno);
                expect(res.transactions).toHaveTransaction({
                    on: newMultisig.address,
                    from: deployer.address,
                    op: Op.multisig.new_order,
                    success: true
                });
                expect(res.transactions).toHaveTransaction({
                    from: newMultisig.address,
                    on: orderAddress,
                    deploy: true,
                    success: true
                });
            })
            it('subsequent order creation with same seqno should result in vote', async () => {
                const rndSeqno  = BigInt(getRandomInt(100, 20000));
                const orderContract = blockchain.openContract(Order.createFromAddress(
                    await newMultisig.getOrderAddress(rndSeqno)
                ));
                const msgPrices = getMsgPrices(blockchain.config, 0);
                const idxMap = Array.from(signers.keys());
                const approveOnInit = true;
                let idxCount = idxMap.length - 1;

                let initTxRes: SendMessageResult | null = null;

                for(let i = 0; i < newMultisig.configuration!.threshold; i++) {
                    let signerIdx = idxMap.splice(getRandomInt(0, idxCount), 1)[0];
                    const signer  = signers[signerIdx];
                    idxCount--;

                    if (i === 0) {
                        initTxRes = await newMultisig.sendNewOrder(blockchain.sender(signer),
                                                                    [testMsg], getExpirationTime(100),
                                                                    toNano('0.5'), signerIdx,
                                                                    approveOnInit, rndSeqno);
                        increaseTime(TIMELOCK_DELAY);

                        expect(initTxRes.transactions).toHaveTransaction({
                            on: newMultisig.address,
                            from: signer,
                            op: Op.multisig.new_order,
                            success: true
                        });

                        findTransactionRequired(initTxRes.transactions,{
                            on: orderContract.address,
                            from: newMultisig.address,
                            op: Op.order.init,
                            success: true
                        });
                    }
                    
                    const executeTx = await orderContract.sendApprove(blockchain.sender(signer), signerIdx);

                    const approveTx = findTransactionRequired(executeTx.transactions, {
                        from: signer,
                        to: orderContract.address,
                        op: Op.order.approve,
                        success: true,
                    });

                    const inMsg = approveTx.inMessage!;
                    if(inMsg.info.type !== "internal"){
                        throw new Error("No way");
                    }

                    const dataAfter = await orderContract.getOrderData();
                    expect(dataAfter.approvals_num).toEqual(i + 1);
                    expect(dataAfter.approvals[signerIdx]).toBe(true);

                    if(i > 0) {
                        const inValue = inMsg.info.value.coins;
                        expect(executeTx.transactions).toHaveTransaction({
                            from: orderContract.address,
                            to: signer,
                            op: Op.order.approved,
                            success: true,
                            // Should return change
                            value: inValue - msgPrices.lumpPrice - computedGeneric(approveTx).gasFees
                        });
                    }
                    if(i + 1 == newMultisig.configuration!.threshold) {
                        expect(executeTx.transactions).toHaveTransaction({
                            from: orderContract.address,
                            to: newMultisig.address,
                            op: Op.multisig.execute
                        });
                    }

                }
            });
        });
    });

    describe('TimeLock', () => {
        const createMsg = (): TransferRequest => ({
            type: "transfer",
            sendMode: 1,
            message: internal_relaxed({
                to: multisig.address,
                value: toNano('0.015'),
                body: beginCell().storeUint(0x12345, 32).endCell()
            })
        })
        
        it("shouldn't able to execute order before timelock expired", async () => {
            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno);
            await multisig.sendNewOrder(proposer.getSender(), [createMsg()], getExpirationTime(1_000));

            const [executeResult] = await approveLastOrder([deployer]);
            expect(executeResult.transactions).toHaveTransaction({
                from: orderAddress,
                to: multisig.address,
                op: Op.multisig.execute,
                success: false,
                exitCode: Errors.multisig.timelock_not_expired
            });

            increaseTime(TIMELOCK_DELAY - 1);

            {
                const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno);
                await multisig.sendNewOrder(proposer.getSender(), [testMsg], getExpirationTime(1_000));

                const [executeResult] = await approveLastOrder([deployer]);
                expect(executeResult.transactions).toHaveTransaction({
                    from: orderAddress,
                    to: multisig.address,
                    success: false,
                    op: Op.multisig.execute,
                    exitCode: Errors.multisig.timelock_not_expired
                });
            }
        });

        it("should be able to execute order after timelock expired", async () => {
            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno);
            await multisig.sendNewOrder(proposer.getSender(), [createMsg()], getExpirationTime(1_000));
            
            increaseTime(TIMELOCK_DELAY);

            const [executeResult] = await approveLastOrder([deployer]);
            expect(executeResult.transactions).toHaveTransaction({
                from: orderAddress,
                to: multisig.address,
                op: Op.multisig.execute,
                success: true,
            });
        });

        it("shouldn't be able create order with expiration date less than timelock date", async () => {
            const orderCreationResult = await multisig.sendNewOrder(proposer.getSender(), [createMsg()], blockchain.now! + TIMELOCK_DELAY  - 1);

            expect(orderCreationResult.transactions).toHaveTransaction({
                from: proposer.address,
                to: multisig.address,
                op: Op.multisig.new_order,
                exitCode: Errors.multisig.expiration_date_less_than_unlock_date,
                success: false,
            });
        });

        it("should be able to cancel order", async () => {
            await multisig.sendNewOrder(proposer.getSender(), [createMsg()], getExpirationTime(1_000));

            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno - 1n);
            const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

            const cancelResult = await orderContract.sendCancel(deployer.getSender(), 0);
            expect(cancelResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: orderAddress,
                op: Op.order.cancel,
                success: true,
            });

            const { isCancelled } = await orderContract.getOrderData();
            expect(isCancelled).toBe(true);
        });

        it("shouldn't be able to execute cancelled order", async () => {
            await multisig.sendNewOrder(proposer.getSender(), [createMsg()], getExpirationTime(1_000));

            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno - 1n);
            const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

            const cancelResult = await orderContract.sendCancel(deployer.getSender(), 0);
            expect(cancelResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: orderAddress,
                op: Op.order.cancel,
                success: true,
            });

            increaseTime(TIMELOCK_DELAY);

            const [executeResult] = await approveLastOrder([deployer]);
            expect(executeResult.transactions).toHaveTransaction({
                from: orderAddress,
                to: multisig.address,
                op: Op.multisig.execute,
                success: false,
                exitCode: Errors.multisig.cancelled
            });
        });

        it("only signer should be able to cancel order", async () => {
            await multisig.sendNewOrder(proposer.getSender(), [createMsg()], getExpirationTime(1_000));

            const orderAddress = await multisig.getOrderAddress((await multisig.getMultisigData()).nextOrderSeqno - 1n);
            const orderContract = blockchain.openContract(Order.createFromAddress(orderAddress));

            const attemptsCount = 10;
            for (let index = 0; index < attemptsCount; index++) {
                const notSigner = await blockchain.treasury(`notSigner${index}`);
                const cancelResult = await orderContract.sendCancel(notSigner.getSender(), 0);

                expect(cancelResult.transactions).toHaveTransaction({
                    from: notSigner.address,
                    to: orderAddress,
                    op: Op.order.cancel,
                    success: false,
                    exitCode: Errors.order.unauthorized_sign
                });
            }

            const cancelResult = await orderContract.sendCancel(deployer.getSender(), 0);
            expect(cancelResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: orderAddress,
                op: Op.order.cancel,
                success: true,
            });
        });
    });
});
