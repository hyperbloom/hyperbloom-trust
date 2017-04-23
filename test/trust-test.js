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

  beforeEach(() => {
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
      expiration = Date.now() / 1000 + 1000;
    return chain.issueLink({ publicKey: to.publicKey, expiration },
                           from.secretKey);
  }

  it('should add/find link', (cb) => {
    const chain = [ edge(0, 1), edge(1, -1) ];
    trust.addChain(pairs[0].publicKey, chain, (err) => {
      assert(!err);

      trust.getChain(pairs[0].publicKey, (err, actual) => {
        assert(!err);
        assert.deepEqual(actual, chain);
        cb();
      });
    });
  });
});
