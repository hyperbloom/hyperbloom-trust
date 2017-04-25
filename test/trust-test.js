'use strict';

const assert = require('assert');
const path = require('path');
const rimraf = require('rimraf');
const signatures = require('sodium-signatures');
const HyperChain = require('hyperbloom-chain');

const Trust = require('../');

const DB_DIR = path.join(__dirname, 'tmp');

function equalChains(a, b) {
  assert.deepEqual(a.map(x => x.toString('base64')),
                   b.map(x => x.toString('base64')));
}

describe('Trust', () => {
  const self = signatures.keyPair();

  // Just to build graphs
  const pairs = [];
  for (let i = 0; i < 10; i++)
    pairs[i] = signatures.keyPair();

  let trust;
  let now;

  beforeEach(() => {
    now = Date.now() / 1000;
    rimraf.sync(DB_DIR);
    trust = new Trust({
      db: DB_DIR,
      privateKey: self.secretKey,
      publicKey: self.publicKey
    });
  });

  afterEach((cb) => {
    trust.close(() => {
      rimraf.sync(DB_DIR);
      cb();
    });
  });

  function toPair(i) {
    return i === -1 ? self : pairs[i];
  }

  function edge(from, to, expiration) {
    from = toPair(from);
    to = toPair(to);

    const chain = new HyperChain({ root: from.publicKey });
    if (!expiration)
      expiration = 1000;
    expiration += now;
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
        equalChains(actual, chain);
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
          equalChains(actual, shortChain);
          cb();
        });
      });
    });
  });

  it('should return empty chain when needed', (cb) => {
    trust.getChain(self.publicKey, (err, actual) => {
      assert(!err);
      assert.deepEqual(actual, []);
      cb();
    });
  });

  it('should invalidate expiring links', (cb) => {
    const longChain = [ edge(0, 1), edge(1, 2), edge(2, -1) ];
    const shortChain = [ edge(0, 3, 0.5), edge(3, -1, 0.5) ];

    const root = pairs[0].publicKey;

    function expireCheck() {
      trust.getChain(root, (err, actual) => {
        assert(!err);
        equalChains(actual, longChain);
        cb();
      });
    }

    function check() {
      trust.getChain(root, (err, actual) => {
        assert(!err);
        equalChains(actual, shortChain);

        setTimeout(expireCheck, 1000);
      });
    }

    trust.addChain(root, longChain, (err) => {
      assert(!err);
      trust.addChain(root, shortChain, (err) => {
        assert(!err);
        check();
      });
    });
  });

  it('should cache chains', (cb) => {
    const chain = [ edge(0, 1), edge(1, -1) ];

    const root = pairs[0].publicKey;
    trust.addChain(root, chain, (err) => {
      assert(!err);

      trust.getChain(root, (err, expected) => {
        assert(!err);
        trust.getChain(root, (err, actual) => {
          assert(!err);
          assert.deepEqual(actual, expected);
          cb();
        });
      });
    });
  });
});
