import { CoinModel, ICoin, SpentHeightIndicators } from './coin';
import { WalletAddressModel } from './walletAddress';
import { partition } from '../utils/partition';
import { ObjectID } from 'bson';
import { TransformOptions } from '../types/TransformOptions';
import { LoggifyClass } from '../decorators/Loggify';
import { Bitcoin } from '../types/namespaces/Bitcoin';
import { BaseModel, MongoBound } from './base';
import logger from '../logger';
import config from '../config';
import { BulkWriteOpResultObject } from 'mongodb';
import { StreamingFindOptions, Storage } from '../services/storage';
import * as lodash from 'lodash';

const Chain = require('../chain');

const addressCacheStore = {
  list: [] as Array<any>,
  map: new Map() as Map<any, string>
};

function getCachedAddress(chain: string, network: string, script: string){
  const result = addressCacheStore.map.get(`${chain}:${network}:${script}`);
  if (result) {
    addressCacheStore.list.push(`${chain}:${network}:${script}`);
    if (addressCacheStore.list.length > 100000) {
      addressCacheStore.map.delete(addressCacheStore.list.shift());
    }
  }
  return result;
}

function setCachedAddress(chain: string, network: string, script: any, address: any) {
  addressCacheStore.map.set(`${chain}:${network}:${script}`, address);
  addressCacheStore.list.push(`${chain}:${network}:${script}`);
  if (addressCacheStore.list.length > 100000) {
    addressCacheStore.map.delete(addressCacheStore.list.shift());
  }
}

export type ITransaction = {
  txid: string;
  chain: string;
  network: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: Date;
  blockTimeNormalized?: Date;
  coinbase: boolean;
  value: number;
  fee: number;
  size: number;
  locktime: number;
  wallets: ObjectID[];
};

@LoggifyClass
export class Transaction extends BaseModel<ITransaction> {
  constructor() {
    super('transactions');
  }

  allowedPaging = [{ key: 'blockHeight' as 'blockHeight', type: 'number' as 'number' }];

  onConnect() {
    this.collection.createIndex({ txid: 1 });
    this.collection.createIndex({ blockHeight: 1, chain: 1, network: 1 });
    this.collection.createIndex({ blockHash: 1 });
    this.collection.createIndex({ blockTimeNormalized: 1, chain: 1, network: 1 });
    this.collection.createIndex({ wallets: 1, blockTimeNormalized: 1, _id: -1 }, { sparse: true });
  }

  async batchImport(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    mempoolTime?: Date;
    blockTime?: Date;
    blockHash?: string;
    blockTimeNormalized?: Date;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    initialSyncComplete: boolean;
  }) {
    const mintOps = await this.getMintOps(params);
    const spendParams = { ...params, mintOps };
    const spendOps = this.getSpendOps(spendParams);

    logger.debug('Minting Coins', mintOps.length);
    let mintWrites = new Array<Promise<BulkWriteOpResultObject>>();
    if (mintOps.length) {
      const mintBatches = partition(mintOps, mintOps.length / config.maxPoolSize);
      mintWrites = mintBatches.map(mintBatch => CoinModel.collection.bulkWrite(mintBatch, { ordered: false }));
    }
    await Promise.all(mintWrites);

    logger.debug('Spending Coins', spendOps.length);
    let spendWrites = new Array<Promise<BulkWriteOpResultObject>>();
    if (spendOps.length) {
      const spendBatches = partition(spendOps, spendOps.length / config.maxPoolSize);
      spendWrites = spendBatches.map(spendBatch => CoinModel.collection.bulkWrite(spendBatch, { ordered: false }));
    }
    await Promise.all(spendWrites);

    let txs: Promise<BulkWriteOpResultObject>[] = [];
    if (mintOps) {
      const addTxParams = { ...params, mintOps };
      let txOps = await this.addTransactions(addTxParams);
      logger.debug('Writing Transactions', txOps.length);
      const txBatches = partition(txOps, txOps.length / config.maxPoolSize);
      txs = txBatches.map(txBatch => this.collection.bulkWrite(txBatch, { ordered: false, j: false, w: 0 }));
    }

    await Promise.all(txs);
  }

  async addTransactions(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    blockTime?: Date;
    blockHash?: string;
    blockTimeNormalized?: Date;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps: Array<any>;
  }) {
    let { blockHash, blockTime, blockTimeNormalized, chain, height, network, txs } = params;
    let txids = txs.map(tx => tx._hash);

    const spent = await CoinModel.collection.find({ spentHeight: height, chain, network }).project({spentTxid: 1, value: 1, wallets: 1}).toArray();
    type CoinGroup = { [txid: string]: { total: number; wallets: Array<ObjectID> } };
    const groupedMints = params.mintOps.reduce<CoinGroup>((agg, coinOp) => {
      const mintTxid = coinOp.updateOne.filter.mintTxid;
      const coin = coinOp.updateOne.update.$set;
      const { value, wallets } = coin;
      if (!agg[mintTxid]) {
        agg[mintTxid] = {
          total: value,
          wallets: wallets || []
        };
      } else {
        agg[mintTxid].total += value;
        agg[mintTxid].wallets.push(...wallets);
      }
      return agg;
    }, {});

    const groupedSpends = spent.reduce<CoinGroup>((agg, coin) => {
      if (!agg[coin.spentTxid]) {
        agg[coin.spentTxid] = {
          total: coin.value,
          wallets: coin.wallets || []
        };
      } else {
        agg[coin.spentTxid].total += coin.value;
        agg[coin.spentTxid].wallets.push(...coin.wallets);
      }
      return agg;
    }, {});

    let txOps = txs.map((tx, index) => {
      const txid = tx._hash!;
      const minted = groupedMints[txid] || {};
      const spent = groupedSpends[txid] || {};
      const mintedWallets = minted.wallets || [];
      const spentWallets = spent.wallets || [];
      const txWallets = mintedWallets.concat(spentWallets);
      const wallets = lodash.uniqBy(txWallets, wallet => wallet.toHexString());
      let fee = 0;
      if (groupedMints[txid] && groupedSpends[txid]) {
        fee = groupedSpends[txid].total - groupedMints[txid].total;
        if (fee < 0) {
          console.error(txid, groupedSpends[txid], groupedMints[txid]);
        }
      }

      return {
        updateOne: {
          filter: { txid: txids[index], chain, network },
          update: {
            $set: {
              chain,
              network,
              blockHeight: height,
              blockHash,
              blockTime,
              blockTimeNormalized,
              coinbase: tx.isCoinbase(),
              fee,
              size: tx.toBuffer().length,
              locktime: tx.nLockTime,
              value: tx.outputAmount,
              wallets
            }
          },
          upsert: true,
          forceServerObjectId: true
        }
      };
    });
    return txOps;
  }

  async getMintOps(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps?: Array<any>;
  }): Promise<Array<any>> {
    let { chain, height, network, txs, parentChain, forkHeight, initialSyncComplete } = params;
    let mintOps = new Array<any>();
    let parentChainCoins = new Array<ICoin>();
    let parentChainCoinsMap = new Map();
    if (parentChain && forkHeight && height < forkHeight) {
      parentChainCoins = await CoinModel.collection
        .find({
          chain: parentChain,
          network,
          mintHeight: height,
          spentHeight: { $lt: SpentHeightIndicators.minimum, $gte: forkHeight }
        }).project({mintTxid:1, mintIndex: 1})
        .toArray();
        for (const parentChainCoin of parentChainCoins) {
          parentChainCoinsMap.set(`${parentChainCoin.mintTxid}:${parentChainCoin.mintIndex}`, true);
        }
    }
    for (let tx of txs) {
      tx._hash = tx.hash;
      let txid = tx._hash;
      let isCoinbase = tx.isCoinbase();
      for (let [index, output] of tx.outputs.entries()) {
        if ((parentChain && forkHeight && height < forkHeight) && (!parentChainCoins.length || !parentChainCoinsMap.get(`${txid}:${index}`))) {
          continue;
        }
        let address = '';
        if (output.script) {
          const hexScript = output.script.toHex();
          const cachedAddress = getCachedAddress(chain, network, hexScript);
          if (cachedAddress) {
            address = cachedAddress;
          } else {
            address = output.script.toAddress(network).toString(true);
            if (address === 'false' && output.script.classify() === 'Pay to public key') {
              let hash = Chain[chain].lib.crypto.Hash.sha256ripemd160(output.script.chunks[0].buf);
              address = Chain[chain].lib.Address(hash, network).toString(true);
            }
            setCachedAddress(chain, network, output.script.toHex(), address);
          }
        }

        mintOps.push({
          updateOne: {
            filter: {
              mintTxid: txid,
              mintIndex: index,
              spentHeight: { $lt: SpentHeightIndicators.minimum },
              chain,
              network
            },
            update: {
              $set: {
                chain,
                network,
                address,
                mintHeight: height,
                coinbase: isCoinbase,
                value: output.satoshis,
                script: output.script.toBuffer(),
                spentHeight: SpentHeightIndicators.unspent,
                wallets: []
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        });
      }
    }

    if (initialSyncComplete) {
      let mintOpsAddresses = mintOps.map(mintOp => mintOp.updateOne.update.$set.address);
      let wallets = await WalletAddressModel.collection
        .find({ address: { $in: mintOpsAddresses }, chain, network }, { batchSize: 100 })
        .toArray();
      if (wallets.length) {
        mintOps = mintOps.map(mintOp => {
          let transformedWallets = wallets
            .filter(wallet => wallet.address === mintOp.updateOne.update.$set.address)
            .map(wallet => wallet.wallet);
          mintOp.updateOne.update.$set.wallets = transformedWallets;
          return mintOp;
        });
      }
    }

    return mintOps;
  }

  getSpendOps(params: {
    txs: Array<Bitcoin.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    mintOps?: Array<any>;
  }): Array<any> {
    let { chain, network, height, txs, parentChain, forkHeight, mintOps } = params;
    let spendOps: any[] = [];
    if (parentChain && forkHeight && height < forkHeight) {
      return spendOps;
    }
    let mintMap = {};
    for (let mintOp of mintOps || []) {
      mintMap[mintOp.updateOne.filter.mintTxid] = mintMap[mintOp.updateOne.filter.mintIndex] || {};
      mintMap[mintOp.updateOne.filter.mintTxid][mintOp.updateOne.filter.mintIndex] = mintOp;
    }
    for (let tx of txs) {
      if (tx.isCoinbase()) {
        continue;
      }
      let txid = tx._hash;
      for (let input of tx.inputs) {
        let inputObj = input.toObject();
        let sameBlockSpend = mintMap[inputObj.prevTxId] && mintMap[inputObj.prevTxId][inputObj.outputIndex];
        if (sameBlockSpend) {
          sameBlockSpend.updateOne.update.$set.spentHeight = height;
          sameBlockSpend.updateOne.update.$set.spentTxid = txid;
          if (config.pruneSpentScripts && height > 0) {
            delete sameBlockSpend.updateOne.update.$set.script;
          }
          continue;
        }
        const updateQuery: any = {
          updateOne: {
            filter: {
              mintTxid: inputObj.prevTxId,
              mintIndex: inputObj.outputIndex,
              spentHeight: { $lt: SpentHeightIndicators.minimum },
              chain,
              network
            },
            update: { $set: { spentTxid: txid, spentHeight: height } }
          }
        };
        if (config.pruneSpentScripts && height > 0) {
          updateQuery.updateOne.update.$unset = { script: null };
        }
        spendOps.push(updateQuery);
      }
    }
    return spendOps;
  }

  getTransactions(params: { query: any; options: StreamingFindOptions<ITransaction> }) {
    let originalQuery = params.query;
    const { query, options } = Storage.getFindOptions(this, params.options);
    const finalQuery = Object.assign({}, originalQuery, query);
    return this.collection.find(finalQuery, options).addCursorFlag('noCursorTimeout', true);
  }

  _apiTransform(tx: Partial<MongoBound<ITransaction>>, options: TransformOptions): Partial<ITransaction> | string {
    let transform = {
      _id: tx._id,
      txid: tx.txid,
      network: tx.network,
      blockHeight: tx.blockHeight,
      blockHash: tx.blockHash,
      blockTime: tx.blockTime,
      blockTimeNormalized: tx.blockTimeNormalized,
      coinbase: tx.coinbase,
      locktime: tx.locktime,
      size: tx.size,
      fee: tx.fee
    };
    if (options && options.object) {
      return transform;
    }
    return JSON.stringify(transform);
  }
}
export let TransactionModel = new Transaction();
