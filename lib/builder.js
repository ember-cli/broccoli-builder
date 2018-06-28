var RSVP = require('rsvp')
var mapSeries = require('promise-map-series')
var apiCompat = require('./api_compat')
var heimdall = require('heimdalljs');
var SilentError = require('silent-error');
var BroccoliBuildError = require('./broccoli-build-error');

exports.Builder = Builder
function Builder (tree) {
  this.tree = tree
  this.allTreesRead = [] // across all builds
  this._currentStep = undefined;
  this.canceled = false;
  this.isThrown = false;
}

function wrapStringErrors(reason) {
  var err

  if (typeof reason === 'string') {
    err = new Error(reason + ' [string exception]')
  } else {
    err = reason
  }

  throw err
}

function summarize(node) {
  return {
    directory: node.directory,
    graph: node,
  }
}

RSVP.EventTarget.mixin(Builder.prototype)


const UBER_CACHE = {
  buildType: 'initial',
  substrExistsInArray(str, arr) {
    let size = arr.length;
    for (let i = 0; i < size; i++) {
      if (str.includes(arr[i])) {
        return true;
      }
    }
    return false;
  },
  leafCache: new Map(),
  stylesTrees: [
    'styles',
    'Concat: Vendor Styles/assets/vendor.css',
    'Funnel (styles)'
  ],
  compiledHBSandJSTrees: [
    'TreeMerger (preprocessedApp & templates)',
    'Babel: frontend',
    // 'Funnel (ember-cli-tree)',
    'TreeMerger (appAndDependencies)',
    'Concat App',
    'Assembler (vendor & appJS)'
  ],
  templatesTrees: [
    'TreeMerger (templates)',
    'ProcessedTemplateTree',
    'Funnel: Pod Templates'
  ],
  jsTrees: [
    'Funnel (config)',
    'Funnel: Filtered App',
    'TreeMerger (app)',
    'ProcessedAppTree'
  ],
  annotationTreesPaths: [
    'Addon#treeFor (ember-',
    'Addon#treeFor (liquid-',
    'Addon#treeForPublic',
    'Addon#treeForStyles',
    '#treeForVendor',
    'Addon#_addonTemplateFiles',
    'Addon#compileAddon',
    'addonPreprocessTree(template)',
    'Babel: ember-',
    'Babel: @ember-',
    'Funnel: addon-tree-output',
    'Babel: moment',
    "TreeMerger: `addon/` trees",
    "TreeMerger: (vendor)",
    "Funnel (vendor)",
    'Vendor JS',
    'Babel: liquid-',
    'Creator math/',
    'Creator ember-'
  ],
  excludedAnnotationTreesPaths: ['Babel: ember-data'],
  directoryTrees: ['ember-','node_modules','ember/','moment'],
  hasCachableAnnotation(subtree) {
    let annotation = subtree._annotation;
    let destDir = subtree.destDir;
    let name = subtree.name;
    let key = annotation;

    let has =  annotation && 
    (this.substrExistsInArray(annotation, this.annotationTreesPaths)
      || this.stylesTrees.includes(annotation)
      || this.templatesTrees.includes(annotation)
      || this.jsTrees.includes(annotation)
      || this.compiledHBSandJSTrees.includes(annotation)
    ) && (
      !this.substrExistsInArray(annotation, this.excludedAnnotationTreesPaths)
    )
  
    if (!has && annotation && annotation.includes('TreeMerger (custom transform:')) {
      has = true;
      key = annotation + subtree.outputPath;
    }
  
    if (!has && annotation && annotation.includes('TreeMerger (ExternalTree)')) {
      has = true;
      key = annotation + subtree.outputPath;
    }
  
    if (!has && name === 'UnwatchedDir') {
      has = true;
      key = name + subtree._directoryPath;
    }
  
    if (!has && name && destDir) {
      has = this.substrExistsInArray(destDir, this.directoryTrees);
  
      if (has) {
        key = name + destDir;
      }
    }
  
    if (!has && name && name === 'broccoli-persistent-filter:ReplaceFilter' && subtree.files && subtree.files.length) {
      has = true;
      key = name + subtree.files.join(':');
    }
  
    return [has, key];
  },
  cleanJSCache() {
    this.jsTrees.map(key=>{
      this.leafCache.delete(key);
    });
  },
  cleanStylesCache() {
    this.stylesTrees.map(key=>{
      this.leafCache.delete(key);
    });
  },
  cleanTemplatesCache() {
    this.templatesTrees.map(key=>{
      this.leafCache.delete(key);
    })
  },
  cleanExtraCache() {
    this.compiledHBSandJSTrees.map(key=>{
      this.leafCache.delete(key);
    });
  },
  cleanUp(changedFiles = []) {
    if (!changedFiles.length) {
      return;
    }
    let hasChangedStyles = changedFiles.filter(file=>{
      return file.includes('.scss') || file.includes('.css');
    }).length;
    let hasChangedTemplates = changedFiles.filter(file=>{
      return file.includes('.hbs');
    }).length;
    let hasChangedScripts = changedFiles.filter(file=>{
      return file.includes('.js');
    }).length;
  
    if (hasChangedScripts) {
      this.cleanJSCache();
    }
    if (hasChangedStyles) {
      this.cleanStylesCache();
    }
    if (hasChangedTemplates) {
      this.cleanTemplatesCache();
    }
    if (hasChangedScripts || hasChangedTemplates) {
      this.cleanExtraCache();
    }
  },
  getItemFromCache(subtree) {
    if (this.isFirstBuild()) {
      return false;
    }
    let [has, key] = this.hasCachableAnnotation(subtree);
    if (has && this.leafCache.has(key)) {
      return this.leafCache.get(key);
    } else {
      // console.log(subtree);
      // console.log('-------------');
    }
    return false;
  },
  addItemToCache(subtree, childNode) {
    if (this.isFirstBuild()) {
      return false;
    }
    let [hasItem, itemKey] = this.hasCachableAnnotation(subtree);
    if (hasItem) {
      this.leafCache.set(itemKey, childNode);
    } else {
      if (subtree._annotation) {
        console.log(subtree._annotation);
      }
    }
  },
  isFirstBuild() {
    return this.buildType === 'initial';
  },
  setStrategy({changedFiles, type}) {
    this.buildType = type;
    if (!this.isFirstBuild()) {
      this.cleanUp(changedFiles);
    }
  }
}

Builder.prototype.build = function (willReadStringTree, resultAnnotation) {

  if (this.canceled) {
    return RSVP.Promise.reject(new Error('cannot build this builder, as it has been previously canceled'));
  }

  UBER_CACHE.setStrategy(resultAnnotation);

  var builder = this

  var newTreesRead = []
  var nodeCache = []
  var hasMergedInstantiationStack = false;
  this.isThrown = false;

  this._currentStep = RSVP.Promise.resolve()
    .then(function () {
      // added for backwards compat. Can be safely removed for 1.0.0
      builder.trigger('start');
      return readAndReturnNodeFor(builder.tree) // call builder.tree.read()
    })
    .then(summarize)
    .finally(appendNewTreesRead)
    .finally(unsetCurrentStep)
    .finally(function() {
      // added for backwards compat. Can be safely removed for 1.0.0
      builder.trigger('end');
    })
    .catch(wrapStringErrors)

  return this._currentStep;

  function unsetCurrentStep() {
    builder._currentStep = null
  }


  function appendNewTreesRead() {
    for (var i = 0; i < newTreesRead.length; i++) {
      if (builder.allTreesRead.indexOf(newTreesRead[i]) === -1) {
        builder.allTreesRead.push(newTreesRead[i])
      }
    }
  }

  // Read the `tree` and return its node, which in particular contains the
  // tree's output directory (node.directory)
  function readAndReturnNodeFor (tree) {
    
    if (builder.canceled) {
      var canceled = new SilentError('Build Canceled');
      canceled.wasCanceled = true
      return RSVP.Promise.reject(canceled);
    }

    // console.log('readAndReturnNodeFor', tree._directoryPath);
    builder.warnIfNecessary(tree)
    tree = builder.wrapIfNecessary(tree)
    var index = newTreesRead.indexOf(tree)
    if (index !== -1) {

      // Return node from cache to deduplicate `.read`
      if (nodeCache[index].directory == null) {
        // node.directory gets set at the very end, so we have found an as-yet
        // incomplete node. This can happen if there is a cycle.
        throw new Error('Tree cycle detected')
      }
      var cachedNode = nodeCache[index];

      heimdall.start({
        name: getDescription(cachedNode.tree),
        broccoliNode: true,
        broccoliId: cachedNode.id,
        broccoliCachedNode: true,
        broccoliPluginName: getPluginName(cachedNode.tree)
      }).stop();

      return RSVP.Promise.resolve(cachedNode)
    }

    var node = new Node(tree);
    var cookie = heimdall.start({
      name: getDescription(tree),
      broccoliNode: true,
      broccoliId: node.id,
      broccoliCachedNode: false,
      broccoliPluginName: getPluginName(tree)
    });

    node.__heimdall__ = heimdall.current;
    // better to use promises via heimdall.node(description, fn)

    // we don't actually support duplicate trees, as such we should likely tag them..
    // and kill the parallel array structure
    newTreesRead.push(tree)
    nodeCache.push(node)

    var treeDirPromise

    if (typeof tree === 'string') {
      treeDirPromise = RSVP.Promise.resolve()
        .then(function () {
          if (willReadStringTree) willReadStringTree(tree)
          return tree
        })
    } else if (!tree || (typeof tree.read !== 'function' && typeof tree.rebuild !== 'function')) {
      throw new Error('Invalid tree found. You must supply a path or an object with a `.read` (deprecated) or `.rebuild` function: ' + getDescription(tree))
    } else {
      var readTreeRunning = false
      treeDirPromise = RSVP.Promise.resolve()
        .then(function () {
          return tree.read(function readTree (subtree) {
            if (readTreeRunning) {
              throw new Error('Parallel readTree call detected; read trees in sequence, e.g. using https://github.com/joliss/promise-map-series')
            }

            let cachedItem = UBER_CACHE.getItemFromCache(subtree);
            if (cachedItem) {
              node.addChild(cachedItem);
              return cachedItem.directory;
            }

            readTreeRunning = true

            return RSVP.Promise.resolve()
              .then(function () {
                return readAndReturnNodeFor(subtree) // recurse
              })
              .then(function (childNode) {
               
                UBER_CACHE.addItemToCache(subtree, childNode);
                
                node.addChild(childNode)
                return childNode.directory
              })
              .finally(function () {
                readTreeRunning = false
              })
          })
        }).catch(function(e) {
          if (typeof e === 'object' && e !== null && e.isSilentError) {
            throw e;
          }

          // because `readAndReturnNodeFor` is recursive
          // it does not make sense to throw multiple build errors,
          // we can just report a failure once.
          if (!builder.isThrown) {
            builder.isThrown = true;
            throw new BroccoliBuildError(e, node)
          }

          if (!hasMergedInstantiationStack) {
            e.stack = e.stack +  '\n\nThe broccoli plugin was instantiated at: \n' + tree._instantiationStack + '\n\n'
            e.message = 'The Broccoli Plugin: ' + tree + ' failed with:'
            hasMergedInstantiationStack = true
          }
          throw e
        })
        .then(function (dir) {
          if (readTreeRunning) {
            throw new Error('.read returned before readTree finished')
          }

          return dir
        })
    }

    return treeDirPromise
      .then(function (treeDir) {
        cookie.stop();

        if (treeDir == null) throw new Error(tree + ': .read must return a directory')
        node.directory = treeDir
        return node
      })
  }
}

function cleanupTree(tree) {
  if (typeof tree !== 'string') {
    return tree.cleanup()
  }
}

Builder.prototype._cancel = function () {
  this.canceled = true;
  return this._currentStep || RSVP.Promise.resolve();
};

Builder.prototype.cleanup = function () {
  var builder = this;

  return this._cancel().finally(function() {
    return mapSeries(builder.allTreesRead, cleanupTree)
  }).catch(function(e) {
    if (typeof e === 'object' && e !== null && e.wasCanceled) {
      // if the exception is that we canceled, then cancellation was
      // non-exceptional and we can safely recover
    } else {
      throw e;
    }
  });
}

Builder.prototype.wrapIfNecessary = function (tree) {
  if (typeof tree.rebuild === 'function') {
    console.log('tree.rebuild', tree);
    // Note: We wrap even if the plugin provides a `.read` function, so that
    // its new `.rebuild` function gets called.
    if (!tree.wrappedTree) { // memoize
      tree.wrappedTree = new apiCompat.NewStyleTreeWrapper(tree)
    }
    return tree.wrappedTree
  } else {
    return tree
  }
}

Builder.prototype.warnIfNecessary = function (tree) {
  if (process.env.BROCCOLI_WARN_READ_API &&
      (typeof tree.read === 'function' || typeof tree.rebuild === 'function') &&
      !tree.__broccoliFeatures__ &&
      !tree.suppressDeprecationWarning) {
    if (!this.didPrintWarningIntro) {
      console.warn('[API] Warning: The .read and .rebuild APIs will stop working in the next Broccoli version')
      console.warn('[API] Warning: Use broccoli-plugin instead: https://github.com/broccolijs/broccoli-plugin')
      this.didPrintWarningIntro = true
    }
    console.warn('[API] Warning: Plugin uses .read/.rebuild API: ' + getDescription(tree))
    tree.suppressDeprecationWarning = true
  }
}


var nodeId = 0

function Node(tree, heimdall) {
  this.id = nodeId++
  this.subtrees = []
  this.tree = tree
  this.parents = []
  this.__heimdall__ = heimdall;
  // mimic information that `broccoliNodeInfo` returns
  this.info = {
    name: getPluginName(tree),
    annotation: getDescription(tree)
  }
}

Node.prototype.addChild = function Node$addChild(child) {
  this.subtrees.push(child)
}

Node.prototype.inspect = function() {
  return 'Node:' + this.id +
    ' subtrees: ' + this.subtrees.length
}

Node.prototype.toJSON = function() {
  var description = getDescription(this.tree)
  var subtrees = this.subtrees.map(function(node) {
    return node.id
  })

  return {
    id: this.id,
    description: description,
    instantiationStack: this.tree._instantiationStack,
    subtrees: subtrees,
  }
}

exports.getPluginName = getPluginName
function getPluginName(tree) {
  // string trees or plain POJO trees don't really have a plugin name
  if (!tree || tree.constructor === String || tree.constructor === Object) {
    return undefined;
  }
  return tree && tree.constructor && tree.constructor !== String && tree.constructor.name
}

exports.getDescription = getDescription
function getDescription (tree) {
  return (tree && tree.annotation) ||
    (tree && tree.description) ||
    getPluginName(tree) ||
    ('' + tree)
}
