var test = require('tap').test
var broccoli = require('..')
var Builder = broccoli.Builder
var RSVP = require('rsvp')
var heimdall = require('heimdalljs')

RSVP.on('error', function(error) {
  throw error
})


test('PURE SOULS ARE function', function (t) {
  function assertReads(t, builder, actualReads, expectedReads) {
    return builder.build().then(function (hash) {
      // ensure depth first order, so the rest of our tests make sense
      t.deepEqual(actualReads.slice(), expectedReads);
      actualReads.length = 0; // reset state;
    });
  }

  test('PURE SOULS ARE IMMUNE', function(t) {
    function Plugin(path, inputTrees) {
      this.name = path;
      this._path = path;
      this.inputTrees = inputTrees || [];
    }

    var reads = [];

    Plugin.prototype.rebuild = function(readTree) {
      this.revised();
      reads.push(this._path);
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

    assertReads(t, builder, reads, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).then(function() {
      // no changes, and all are pure
      return assertReads(t, builder, reads, []);
    }).then(function() {
      a.revised();
      return assertReads(t, builder, reads, ['d', 'h']);
    }).then(function() {
      a.revised();
      f.revised();
      return assertReads(t, builder, reads, ['d', 'g', 'h']);
    }).then(function() {
      e.revised();
      return assertReads(t, builder, reads, ['h']);
    }).then(function() {
      f.revised();
      return assertReads(t, builder, reads, ['g', 'h']);
    }).then(function() {
      h.revised();
      return assertReads(t, builder, reads, []);
    })
      .finally(function() {
        return builder.cleanup();
      }).finally(function(){
        t.end();
      });
  });
  t.end()
})

