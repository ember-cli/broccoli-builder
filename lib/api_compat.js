var fs = require('fs')
var RSVP = require('rsvp')
var quickTemp = require('quick-temp')
var mapSeries = require('promise-map-series')
var rimraf = require('rimraf')


// Wrap a new-style plugin to provide the .read API

exports.NewStyleTreeWrapper = NewStyleTreeWrapper
function NewStyleTreeWrapper (newStyleTree) {
  this.newStyleTree = newStyleTree
  this.description = newStyleTree.description ||
    (newStyleTree.constructor && newStyleTree.constructor.name) ||
    'NewStyleTreeWrapper'

  this._lastInputTreeRevisions = newStyleTree.inputTrees.map(function() { return NaN; });

  this.revision = NaN;
  // for now, if you have no inputs you are considered volatile
  var node = this;
  newStyleTree.__wrapper = this;
  newStyleTree.revised = function() {
    return node.revised();
  };
}

function getRevision(tree) {
  var wrapper = tree.__wrapper;
  return ('revision' in wrapper) ? wrapper.revision : NaN;
}

NewStyleTreeWrapper.prototype.revised = function() {
  if (this.revision !== this.revision) {
    this.revision = 0;
  } else {
    this.revision++;
  }
};

NewStyleTreeWrapper.prototype.inputsHaveRevisions = function() {
  var hasRevisions = false;

  for (var i = 0; i < this.newStyleTree.inputTrees.length; i++) {
    var inputTree = this.newStyleTree.inputTrees[i];
    var lastRevision = this._lastInputTreeRevisions[i];
    var currentRevision = getRevision(inputTree);

    // update our last known revision state
    this._lastInputTreeRevisions[i] = currentRevision;

    if (lastRevision !== currentRevision) {
      hasRevisions = true;
    }
  }

  return hasRevisions;
};

NewStyleTreeWrapper.prototype.read = function (readTree) {
  var tree = this.newStyleTree
  var wrapper = this;

  quickTemp.makeOrReuse(tree, 'cachePath')
  quickTemp.makeOrReuse(tree, 'outputPath') // reuse to keep name across rebuilds
  rimraf.sync(tree.outputPath)
  fs.mkdirSync(tree.outputPath)

  if (!tree.inputTrees && !tree.inputTree) {
    throw new Error('No inputTree/inputTrees set on tree: ' + this.description)
  }
  if (tree.inputTree && tree.inputTrees) {
    throw new Error('Cannot have both inputTree and inputTrees: ' + this.description)
  }

  var inputTrees = tree.inputTrees || [tree.inputTree]
  return mapSeries(inputTrees, readTree)
    .then(function (inputPaths) {
      if (tree.inputTree) { // singular
        tree.inputPath = inputPaths[0]
      } else { // plural
        tree.inputPaths = inputPaths
      }
      return RSVP.resolve().then(function () {
        if (wrapper.inputsHaveRevisions() || wrapper.revision !== wrapper.revision) {
          return tree.rebuild()
        }
      }).then(function () {
        return tree.outputPath
      }, function (err) {
        // Pull in properties from broccoliInfo, and wipe properties that we
        // won't support under the new API
        delete err.treeDir
        var broccoliInfo = err.broccoliInfo || {}
        err.file = broccoliInfo.file
        err.line = broccoliInfo.firstLine
        err.column = broccoliInfo.firstColumn
        throw err
      })
    })
}

NewStyleTreeWrapper.prototype.cleanup = function () {
  quickTemp.remove(this.newStyleTree, 'outputPath')
  quickTemp.remove(this.newStyleTree, 'cachePath')
  if (this.newStyleTree.cleanup) {
    return this.newStyleTree.cleanup()
  }
}
