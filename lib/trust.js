'use strict';

const assert = require('assert');
const async = require('async');
const level = require('level');
const debug = require('debug')('hyperbloom:trust');
const constants = require('hyperbloom-constants');
const Buffer = require('buffer').Buffer;
const HyperChain = require('hyperbloom-chain');
const LRU = require('lru');

const LINK_PREFIX = 'l/';
const LRU_SIZE = 128;

function debugKey(key) {
  if (!debug.enabled)
    return;

  return key.slice(0, 4).toString('hex');
}

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

  this._lru = new LRU(LRU_SIZE);
}
module.exports = Trust;

Trust.prototype.close = function close(cb) {
  this.db.close(cb);
};

Trust.prototype.addChain = function addChain(root, raw, callback) {
  if (raw.length === 0)
    return;

  let prev = root;
  const links = raw.map((raw) => {
    const res = {
      raw,
      signedBy: prev,
      link: this._chain.parseLink(raw)
    };
    prev = res.link.publicKey;
    return res;
  });

  // Store the link from the leafs to naturally build the depth
  async.forEachSeries(links.slice().reverse(), (link, callback) => {
    this._addLink(link.signedBy, link.link, link.raw, callback);
  }, (err) => {
    if (callback)
      return callback(err);
  });
};

Trust.prototype.getChain = function getChain(root, callback) {
  if (root.equals(this.publicKey))
    return process.nextTick(callback, null, []);

  this._getChain([], root, callback);
};

// Private

Trust.prototype._addLink = function _addLink(signedBy, link, raw, callback) {
  const debugFrom = debugKey(signedBy);
  const debugTo = debugKey(link.publicKey);
  debug('add signedBy=%s publicKey=%s', debugFrom, debugTo);

  // Get existing link
  this._getLink(signedBy, (err, old) => {
    const signsUs = link.publicKey.equals(this.publicKey);

    // No existing link
    if (err) {
      debug('no existing signedBy=%s publicKey=%s', debugFrom, debugTo);

      // If link is detached from the rest of the graph use negative depth
      this._putLink(signedBy, raw, signsUs ? 0 : -1, callback);
      return;
    }

    // Fast case - same links
    if (old.raw.equals(raw)) {
      debug('same link signedBy=%s publicKey=%s', debugFrom, debugTo);
      return callback(null);
    }

    // Same graph edge, different expiration date
    if (old.link.publicKey.equals(link.publicKey)) {
      if (old.expiration >= link.expiration) {
        debug('outdated link signedBy=%s publicKey=%s', debugFrom, debugTo);
        return callback(null);
      }

      // Update!
      debug('newer link signedBy=%s publicKey=%s', debugFrom, debugTo);
      this._putLink(signedBy, raw, old.depth, callback);
      return;
    }

    // Direct link to us, just overwrite existing link
    // (Previous one was indirect)
    if (signsUs) {
      debug('direct link signedBy=%s publicKey=%s', debugFrom, debugTo);
      this._putLink(signedBy, raw, 0, callback);
      return;
    }

    // Different edges, update only if depth is smaller
    this._getLink(link.publicKey, (err, next) => {
      if (err)
        return callback(err);

      if (next.depth < 0 || old.depth >= 0 && old.depth <= next.depth + 1) {
        debug('deeper link signedBy=%s publicKey=%s', debugFrom, debugTo);
        return callback(null);
      }

      debug('shallow link signedBy=%s publicKey=%s', debugFrom, debugTo);
      this._putLink(signedBy, raw, next.depth + 1, callback);
    })
  });
};

Trust.prototype._getChain = function _getChain(prev, signedBy, callback) {
  this._getLink(signedBy, (err, res) => {
    if (err)
      return callback(err);

    const now = Date.now() / 1000;
    const next = prev.concat(res.raw);
    const link = res.link;

    if (link.expiration <= now)
      return callback(new Error('Route expired'));

    if (link.publicKey.equals(this.publicKey))
      return callback(null, next);

    if (next.length === constants.MAX_CHAIN_LENGTH)
      return callback(new Error('Route length exceeded'));

    this._getChain(next, link.publicKey, callback);
  });
};

Trust.prototype._getLink = function _getLink(signedBy, callback) {
  const onResult = (err, value) => {
    if (err)
      return callback(err);

    const raw = Buffer.from(value.raw, 'base64');

    const depth = value.depth;
    const link = this._chain.parseLink(raw);

    callback(null, { depth, link, raw });
  };

  const key = signedBy.toString('base64');
  const cached = this._lru.get(key);
  if (cached) {
    debug('cache hit');
    return process.nextTick(onResult, null, cached);
  }

  debug('cache miss');
  this.db.get(LINK_PREFIX + signedBy.toString('base64'), {
    valueEncoding: 'json'
  }, onResult);
};

Trust.prototype._putLink = function _putLink(signedBy, raw, depth, callback) {
  const key = signedBy.toString('base64');
  const value = { depth, raw: raw.toString('base64') };
  this._lru.set(key, value);
  this.db.put(LINK_PREFIX + signedBy.toString('base64'), JSON.stringify(value),
              callback);
};
