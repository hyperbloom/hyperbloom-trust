'use strict';

const assert = require('assert');
const path = require('path');
const rimraf = require('rimraf');
const signatures = require('sodium-signatures');
const HyperChain = require('hyperbloom-chain');

const Trust = require('../');

const DB_DIR = path.join(__dirname, 'tmp');

describe('Trust', () => {
  const self = signatures.keyPair();

  // Just to build graphs
  const pairs = [];
  for (let i = 0; i < 10; i++)
    pairs[i] = signatures.keyPair();

  let trust;
  let now;

  beforeEach(() => {
    now = Date.now();
    rimraf.sync(DB_DIR);
    trust = new Trust({
      db: DB_DIR,
      privateKey: self.secretKey,
      publicKey: self.publicKey
    });
  });

  afterEach((cb) => {
    trust.close(cb);
  });

  function toPair(i) {
    return i === -1 ? self : pairs[i];
  }

  function edge(from, to, expiration) {
    from = toPair(from);
    to = toPair(to);

    const chain = new HyperChain({ root: from.publicKey });
    if (!expiration)
      expiration = now / 1000 + 1000;
    return chain.issueLink({ publicKey: to.publicKey, expiration },
                           from.secretKey);
  }

  it('should add/find link', (cb) => {
    const chain = [ edge(0, 1), edge(1, -1) ];

    const root = pairs[0].publicKey;
    trust.addChain(root, chain, (err) => {
      assert(!err);

      trust.getChain(root, (err, actual) => {
        assert(!err);
        assert.deepEqual(actual, chain);
        cb();
      });
    });
  });

  it('should replace chain with more optimal', (cb) => {
    const longChain = [ edge(0, 1), edge(1, 2), edge(2, -1) ];
    const shortChain = [ edge(0, 2), edge(2, -1) ];

    const root = pairs[0].publicKey;
    trust.addChain(root, longChain, (err) => {
      assert(!err);
      trust.addChain(root, shortChain, (err) => {
        assert(!err);
        trust.getChain(root, (err, actual) => {
          assert(!err);
          assert.deepEqual(actual, shortChain);
          cb();
        });
      });
    });
  });
});
