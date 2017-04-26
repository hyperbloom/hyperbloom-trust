'use strict';

const assert = require('assert');
const async = require('async');
const level = require('level');
const debug = require('debug')('hyperbloom:trust');
const constants = require('hyperbloom-constants');
const Buffer = require('buffer').Buffer;
const HyperChain = require('hyperbloom-chain');
const LRU = require('lru');

const LINK_PREFIX = 'l2/';
const LRU_SIZE = 128;

function debugKey(key) {
  if (!debug.enabled)
    return;

  return key.slice(0, 4).toString('hex');
}

function TrustNode() {
  this.children = new Map();
}

TrustNode.prototype.addChild = function addChild(child) {
  this.children.set(child.link.publicKey.toString('hex'), child);
};

TrustNode.prototype.removeChild = function removeChild(key) {
  this.children.delete(key);
};

function Trust(options) {
  assert.equal(typeof options.db, 'string',
               '`options.db` must be a String');
  assert(Buffer.isBuffer(options.privateKey),
         '`options.privateKey` must be a Buffer');
  assert(Buffer.isBuffer(options.publicKey),
         '`options.publicKey` must be a Buffer');

  this.options = options;

  this.db = level(this.options.db);
  this.privateKey = this.options.privateKey;
  this.publicKey = this.options.publicKey;

  // TODO(indutny): root should not be necessary here
  this._chain = new HyperChain({ root: this.publicKey });

  this._graph = new Map();
  this._lru = new LRU(LRU_SIZE);

  this._ready = false;
  this._queue = [];

  this._dbUsed = 0;
  this._dbQueue = [];

  this._load();
}
module.exports = Trust;

// Public

Trust.prototype.close = function close(cb) {
  if (this._dbUsed !== 0) {
    this._dbQueue.push(() => this.close(cb));
    return;
  }

  this.db.close(cb);
};

Trust.prototype.addChain = function addChain(root, raw, callback) {
  if (raw.length === 0)
    return;

  let prev = root;
  raw.forEach((rawLink) => {
    const link = this._chain.parseLink(rawLink);
    this._addLink(prev, rawLink, link);
    prev = link.publicKey;
  });

  if (callback)
    process.nextTick(callback);
};

Trust.prototype.getChain = function getChain(root, callback) {
  if (root.equals(this.publicKey))
    return process.nextTick(callback, null, []);

  if (!this._ready) {
    this._queue.push(() => this.getChain(root, callback));
    return;
  }

  const hexRoot = root.toString('hex');
  if (!this._graph.has(hexRoot))
    return process.nextTick(callback, new Error('No trust path available'));

  const now = Date.now() / 1000;

  const cached = this._lru.get(hexRoot);
  if (cached) {
    if (cached.expiration > now)
      return process.nextTick(callback, null, cached.chain);

    this._lru.remove(hexRoot);
  }

  const visited = new Set();
  const queue = [{
    node: this._graph.get(hexRoot),
    expiration: Infinity,
    chain: []
  }];

  while (queue.length !== 0) {
    const item = queue.pop();
    visited.add(item.node);

    for (let [ trusteeKey, value ] of item.node.children.entries()) {
      // Link expired
      if (value.link.expiration <= now) {
        item.node.removeChild(trusteeKey);

        this._useDB();
        this.db.del(LINK_PREFIX + value.raw.toString('hex'), (err) => {
          this._freeDB();
          if (err)
            debug('db error=%s', err.message);
        });
        continue;
      }

      const chain = item.chain.concat(value.raw);
      const expiration = Math.min(item.expiration, value.link.expiration);

      // Match!
      if (this.publicKey.equals(value.link.publicKey)) {
        this._lru.set(hexRoot, { expiration, chain });
        return process.nextTick(callback, null, chain);
      }

      const child = this._graph.get(trusteeKey);
      if (!child)
        continue;
      if (visited.has(child))
        continue;

      // Chain will can't be too long!
      if (chain.length >= constants.MAX_CHAIN_LENGTH)
        continue;

      queue.push({ node: child, expiration, chain });
    }
  }

  return process.nextTick(callback, new Error('No trust path available'));
};

// Private

Trust.prototype._load = function _load() {
  this._useDB();
  this.db.createReadStream({
    gte: LINK_PREFIX,
    lte: LINK_PREFIX + 'z'
  }).on('data', (data) => {
    const raw = data.key.slice(LINK_PREFIX.length);
    const parent = data.value;
    this._addMemLink(Buffer.from(parent, 'hex'), Buffer.from(raw, 'hex'));
  }).on('end', () => {
    this._freeDB();

    const queue = this._queue;
    this._ready = true;
    this._queue = [];
    for (let i = 0; i < queue.length; i++)
      queue[i]();
  }).on('error', (err) => {
    this._freeDB();

    debug('db error=%s', err.message);
  });
};

Trust.prototype._addLink = function _addLink(parent, raw, link) {
  const now = Date.now() / 1000;

  // Ignore stale links
  if (link.expiration <= now)
    return;

  // Just store it in db as it is
  this._useDB();
  this.db.put(LINK_PREFIX + raw.toString('hex'),
              parent.toString('hex'),
              (err) => {
    this._freeDB();
    if (err)
      debug('db error=%s', err.message);
  });

  this._addMemLink(parent, raw, link);
};

Trust.prototype._addMemLink = function _addMemLink(parent, raw, link) {
  if (!link)
    link = this._chain.parseLink(raw);

  const hexParent = parent.toString('hex');

  let node;
  if (this._graph.has(hexParent)) {
    node = this._graph.get(hexParent);
  } else {
    node = new TrustNode();
    this._graph.set(hexParent, node);
  }

  node.addChild({ link, raw });
};

Trust.prototype._useDB = function _useDB() {
  this._dbUsed++;
};

Trust.prototype._freeDB = function _freeDB() {
  this._dbUsed--;
  assert(this._dbUsed >= 0);
  if (this._dbUsed !== 0)
    return;

  const queue = this._dbQueue;
  this._dbQueue = [];
  for (let i = 0; i < queue.length; i++)
    queue[i]();
};
