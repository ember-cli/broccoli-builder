var test = require('tap').test
var broccoli = require('..')
var Builder = broccoli.Builder
var RSVP = require('rsvp')
var heimdall = require('heimdalljs')

RSVP.on('error', function(error) {
  throw error
})

function countingTree (readFn, description) {
  return {
    read: function (readTree) {
      this.readCount++
      return readFn.call(this, readTree)
    },
    readCount: 0,
    description: description,
    cleanup: function () {
      var self = this

      return RSVP.resolve()
        .then(function() {
          self.cleanupCount++
        })
    },
    cleanupCount: 0
  }
}


test('Builder', function (t) {
  test('core functionality', function (t) {
    t.end()

    test('build', function (t) {
      test('passes through string tree', function (t) {
        var builder = new Builder('someDir')
        builder.build().then(function (hash) {
          t.equal(hash.directory, 'someDir')
          t.end()
        })
      })

      test('calls read on the given tree object', function (t) {
        var builder = new Builder({
          read: function (readTree) { return 'someDir' }
        })
        builder.build().then(function (hash) {
          t.equal(hash.directory, 'someDir')
          t.end()
        })
      })

      t.end()
    })

    test('readTree deduplicates', function (t) {
      var subtree = new countingTree(function (readTree) { return 'foo' })
      var builder = new Builder({
        read: function (readTree) {
          return readTree(subtree).then(function (hash) {
            var dirPromise = readTree(subtree) // read subtree again
            t.ok(dirPromise.then, 'is promise, not string')
            return dirPromise
          })
        }
      })
      builder.build().then(function (hash) {
        t.equal(hash.directory, 'foo')
        t.equal(subtree.readCount, 1)
        t.end()
      })
    })

    test('cleanup', function (t) {
      test('is called on all trees called ever', function (t) {
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function (readTree) { return 'foo' })
        var subtree2 = countingTree(function (readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        builder.build().then(function (hash) {
          t.equal(hash.directory, 'foo')
          builder.build().catch(function (err) {
            t.equal(err.message, 'The Broccoli Plugin: [object Object] failed with:')
            return builder.cleanup()
          })
          .finally(function() {
            t.equal(tree.cleanupCount, 1)
            t.equal(subtree1.cleanupCount, 1)
            t.equal(subtree2.cleanupCount, 1)
            t.end();
          });
        })
      })

      test('cannot build already cleanedup build', function (t) {
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function (readTree) { return 'foo' })
        var subtree2 = countingTree(function (readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        builder.cleanup();
        builder.build().then(function (hash) {
          t.equal(false, true, 'should not succeed')
          t.end();
        }).catch(function(e) {
          t.equal(tree.cleanupCount, 0)
          t.equal(subtree1.cleanupCount, 0)
          t.equal(subtree2.cleanupCount, 0)
          t.equal(e.message, 'cannot build this builder, as it has been previously canceled');
          t.end();
        });
      })

      test('a build step run once the build is cancelled will not wrong, and the build will fail', function (t) {
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          return readTree(this.readCount === 1 ? subtree1 : subtree2)
        })
        var subtree1 = countingTree(function (readTree) { return 'foo' })
        var subtree2 = countingTree(function (readTree) { throw new Error('bar') })
        var builder = new Builder(tree)
        var build = builder.build()
        builder.cleanup();
        build.then(function (hash) {
          t.equal(false, true, 'should not succeed')
          t.end();
        }).catch(function(reason) {
          t.equal(tree.cleanupCount, 0)
          t.equal(subtree1.cleanupCount, 0)
          t.equal(subtree2.cleanupCount, 0)
          t.equal(reason.message, 'Build Canceled');
          t.equal(reason.isSilentError, true);
          t.end();
        });
      })

      test('is calls trees so far read (after one step)', function (t) {
        var cleaner;
        var tree = countingTree(function (readTree) {
          // Interesting edge case: Read subtree1 on the first read, subtree2 on
          // the second
          cleaner = builder.cleanup();
          return readTree(subtree1);
        })
        var subtree1 = countingTree(function (readTree) {
          return 'foo'
        })
        var builder = new Builder(tree)

        builder.build().then(function () {
          t.equal(true, false, 'should not succeed')
        }).catch(function(reason) {
          t.ok(reason.message.indexOf('Build Canceled: Broccoli Builder ran into an error with') !== -1)

          return cleaner.then(function() {
            t.equal(tree.cleanupCount, 1)
            t.equal(subtree1.cleanupCount, 0) // never read the second, so we wont clean it up
            t.end()
          })
        })
      })
      t.end()
    })
  })

  test('tree graph', function (t) {
    var parent = countingTree(function (readTree) {
      return readTree(child).then(function (dir) {
        return readTree(shared).then(function() {
          return new RSVP.Promise(function (resolve, reject) {
            setTimeout(function() { resolve('parentTreeDir') }, 30)
          })
        })
      })
    }, 'parent')

    var child = countingTree(function (readTree) {
      return readTree(shared).then(function (dir) {
        return new RSVP.Promise(function (resolve, reject) {
          setTimeout(function() { resolve('childTreeDir') }, 20)
        })
      })
    }, 'child')

    var shared = countingTree(function (readTree) {
      return readTree('srcDir').then(function (dir) {
        return new RSVP.Promise(function (resolve, reject) {
          setTimeout(function() { resolve('sharedTreeDir') }, 20)
        })
      })
    }, 'shared')

    var timeEqual = function (a, b) {
      t.equal(typeof a, 'number')

      // do not run timing assertions in Travis builds
      // the actual results of process.hrtime() are not
      // reliable
      if (process.env.CI !== 'true') {
        t.ok(a >= b - 5e7 && a <= b + 5e7, a + ' should be within ' + b + ' +/- 5e7')
      }
    }

    var builder = new Builder(parent)
    builder.build().then(function (hash) {
      t.equal(hash.directory, 'parentTreeDir')
      var parentBroccoliNode = hash.graph
      t.equal(parentBroccoliNode.directory, 'parentTreeDir')
      t.equal(parentBroccoliNode.tree, parent)
      t.equal(parentBroccoliNode.subtrees.length, 2)
      var childBroccoliNode = parentBroccoliNode.subtrees[0]
      t.equal(childBroccoliNode.directory, 'childTreeDir')
      t.equal(childBroccoliNode.tree, child)
      t.equal(childBroccoliNode.subtrees.length, 1)
      var sharedBroccoliNode = childBroccoliNode.subtrees[0]
      t.equal(sharedBroccoliNode.subtrees.length, 1)
      var leafBroccoliNode = sharedBroccoliNode.subtrees[0]
      t.equal(leafBroccoliNode.directory, 'srcDir')
      t.equal(leafBroccoliNode.tree, 'srcDir')
      t.equal(leafBroccoliNode.subtrees.length, 0)

      var json = heimdall.toJSON()

      t.equal(json.nodes.length, 6)

      var parentNode = json.nodes[1]
      timeEqual(parentNode.stats.time.self, 30e6)

      var childNode = json.nodes[2]
      timeEqual(childNode.stats.time.self, 20e6)

      var leafNode = json.nodes[3]
      timeEqual(leafNode.stats.time.self, 0)

      for (var i=0; i<json.nodes.length; ++i) {
        delete json.nodes[i].stats.time.self
      }

      t.deepEqual(json, {
        nodes: [{
          _id: 0,
          id: {
            name: 'heimdall',
          },
          stats: {
            own: {},
            time: {},
          },
          children: [1],
        }, {
          _id: 1,
          id: {
            name: 'parent',
            broccoliNode: true,
            broccoliId: 0,
            broccoliCachedNode: false,
            broccoliPluginName: undefined
          },
          stats: {
            own: {},
            time: {},
          },
          children: [2, 5],
        }, {
          _id: 2,
          id: {
            name: 'child',
            broccoliNode: true,
            broccoliId: 1,
            broccoliCachedNode: false,
            broccoliPluginName: undefined
          },
          stats: {
            own: {},
            time: {},
          },
          children: [3],
        }, {
          _id: 3,
          id: {
            name: 'shared',
            broccoliNode: true,
            broccoliId: 2,
            broccoliCachedNode: false,
            broccoliPluginName: undefined
          },
          stats: {
            own: {},
            time: {},
          },
          children: [4],
        }, {
          _id: 4,
          id: {
            name: 'srcDir',
            broccoliNode: true,
            broccoliId: 3,
            broccoliCachedNode: false,
            broccoliPluginName: undefined
          },
          stats: {
            own: {},
            time: {},
          },
          children: [],
        }, {
          _id: 5,
          id: {
            name: 'shared',
            broccoliNode: true,
            broccoliId: 2,
            broccoliCachedNode: true,
            broccoliPluginName: undefined
          },
          stats: {
            own: {},
            time: {},
          },
          children: [],
        }

        ],
      });
    }).finally(function() {
      return builder.cleanup().then(function() {
        t.end()
      })
    });
  })

  test('string tree callback', function (t) {
    var builder = new Builder('fooDir')
    builder.build(function willReadStringTree (dir) {
      t.equal(dir, 'fooDir')
      t.end()
    })
  })

  test('start/stop events', function (t) {
    // Can be removed in 1.0.0
    var builder = new Builder('fooDir')
    var startWasCalled = 0;
    var  stopWasCalled = 0;
    builder.on('start', function() {
      startWasCalled++;
    });

    builder.on('end', function() {
      stopWasCalled++;
    });

    t.equal(startWasCalled, 0);
    t.equal(stopWasCalled, 0);

    builder.build(function willReadStringTree (dir) {
      t.equal(startWasCalled, 1);
      t.equal(stopWasCalled, 0);
      t.equal(dir, 'fooDir')
    }).finally(function() {
      t.equal(startWasCalled, 1);
      t.equal(stopWasCalled, 1);
      t.end()
    })
  })

  function assertReads(t, builder, actualReads, expectedReads) {
    return builder.build().then(function (hash) {
      // ensure depth first order, so the rest of our tests make sense
      t.deepEqual(actualReads.slice(), expectedReads);
      actualReads.length = 0; // reset state;
    });
  }

  test('test compat api', function(t) {
    function Plugin(path, inputTrees) {
      this.name = path;
      this._path = path;
      this.inputTrees = inputTrees || [];
    }

    var actualReads = [];

    Plugin.prototype.rebuild = function(readTree) {
      actualReads.push(this._path);
    };

    var a = new Plugin('a');
    var b = new Plugin('b');
    var c = new Plugin('c');
    var d = new Plugin('d', [a, b, c]);
    var e = new Plugin('e');
    var f = new Plugin('f');
    var g = new Plugin('g', [f]);
    var h = new Plugin('h', [d, e, g]);

    var builder = new Builder(h);
    return builder.build().then(function() {
      return builder.cleanup();
    }).finally(function() {
      t.end();
    });
  });

  t.end()
})

test('getDescription test', function(t) {
  function FakeBaseNode() {}

  test('annotation is used', function(t) {
    var fakeNode = new FakeBaseNode();
    fakeNode.annotation = 'fakeNode: boo';

    var result = broccoli.getDescription(fakeNode);

    t.equal(result, 'fakeNode: boo');
    t.end();
  });

  test('description is used', function(t) {
    var fakeNode = new FakeBaseNode();
    fakeNode.description = 'fakeNode: boo';

    var result = broccoli.getDescription(fakeNode);

    t.equal(result, 'fakeNode: boo');
    t.end();
  });

  test('annotation is used over description', function(t) {
    var fakeNode = new FakeBaseNode();
    fakeNode.annotation = 'fakeNode: boo';
    fakeNode.description = 'fakeNode: who';

    var result = broccoli.getDescription(fakeNode);

    t.equal(result, 'fakeNode: boo');
    t.end();
  });

  test('plugin name is used when no other description is present', function(t) {
    var fakeNode = new FakeBaseNode();

    var result = broccoli.getDescription(fakeNode);

    t.equal(result, 'FakeBaseNode');
    t.end();
  });

  test('string trees description is the path itself', function(t) {
    var fakeNode = 'some/path/here/';

    var result = broccoli.getDescription(fakeNode);

    t.equal(result, 'some/path/here/');
    t.end();
  });

  t.end();
});

test('getPluginName', function(t) {
  function FakeBaseNode() {}

  test('it returns constructor name', function(t) {
    var fakeNode = new FakeBaseNode();
    var result = broccoli.getPluginName(fakeNode);

    t.equal(result, 'FakeBaseNode');
    t.end();
  });

  test('returns undefined for string nodes', function(t) {
    var fakeNode = 'some/path/here/';
    var result = broccoli.getPluginName(fakeNode);

    t.equal(result, undefined);
    t.end();
  });

  test('returns undefined for POJO nodes', function(t) {
    var fakeNode = {};
    var result = broccoli.getPluginName(fakeNode);

    t.equal(result, undefined);
    t.end();
  });

  t.end();
});
