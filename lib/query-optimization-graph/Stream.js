/**
 * Created by joachimvh on 11/09/2014.
 */
/* Stream is responsible for downloading new triples for a node. */

var rdf = require('../util/RdfUtil'),
  _ = require('lodash'),
  TriplePatternIterator = require('../triple-pattern-fragments/TriplePatternIterator'),
  Iterator = require('../iterators/Iterator'),
  Logger = require('../util/Logger'),
  ClusteringUtil = require('./ClusteringUtil'),
  util = require('util');

// Stream is a superclass for the 2 available roles (DownloadStream and BindStream).
// Cost is an estimate of the number of HTTP calls necessary to download all triples.
function Stream(cost, pattern, loggername) {
  this.logger = new Logger(loggername);
  this.logger.disable();

  this.cost = cost;
  this.costRemaining = cost;
  this.pattern = pattern;
  this.ended = false;
  this.triples = [];
  this.tripleCount = 0;
}

Stream.prototype.read = function () {
  throw new Error('Not implemented yet.');
};

Stream.prototype.spend = function (cost) {
  this.costRemaining -= cost;
};

///////////////////////////// DownloadStream /////////////////////////////
function DownloadStream(pattern, count, options) {
  Stream.call(this, count / 100, pattern, "Stream " + rdf.toQuickString(pattern)); // TODO: pagesize

  this._iterator = new TriplePatternIterator(Iterator.single({}), pattern, options);
  this._iterator.setMaxListeners(1000);
  this.remaining = count;
  this.count = count;
  this._buffer = [];

  var self = this;
  this._iterator.on('end', function () {
    self.count = self.tripleCount;
    self.ended = true;
    self.remaining = 0;
  });
}
util.inherits(DownloadStream, Stream);

DownloadStream.prototype.read = function (callback) {
  if (this.ended)
    return setImmediate(function () { callback([]); });

  var self = this;
  var pageSize = 100; // TODO: real pagesize
  var buffer = [];
  var iterator = this._iterator;
  iterator.on('data', addTriple);
  iterator.on('end', end);
  function addTriple(val) {
    buffer.push(rdf.applyBindings(val, self.pattern));
    // Stop reading when we read an entire page (to prevent multiple HTTP calls).
    if (buffer.length >= pageSize || iterator.ended) {
      iterator.removeListener('data', addTriple);
      iterator.removeListener('end', end);
      addBuffer(buffer);
    }
  }
  function end() {
    addBuffer(buffer);
  }
  var added = false;
  function addBuffer(buffer) {
    if (added)
      return;
    added = true;
    self.triples = self.triples.concat(buffer);
    self.tripleCount += buffer.length;
    // TODO: find out why the algorithm didn't continue before I made this change
    if (self.tripleCount > self.count)
      self.count = self.tripleCount + (self.ended ? 0 : 1); // wrong server estimation
    self.remaining = self.count - self.tripleCount;
    setImmediate(function () { callback(buffer); });
  }

  this.cost = Math.max(0, this.remaining - pageSize) / pageSize;
  this.costRemaining = this.cost; // reset since we did a read
};

///////////////////////////// BindingStream /////////////////////////////
function BindingStream(cost, pattern, bindVar, options) {
  Stream.call(this, cost, pattern, "Stream " + rdf.toQuickString(pattern) + " (" + bindVar + ")");

  this.bindVar = bindVar;
  this._options = options;
  this._bindings = [];
  this.results = [];
  this.resultVals = []; // need this for feeding
  this._streams = [];
  this._gotAllData = false;
  this.ended = false; // it is important updateRemaining gets called at least once to make sure this value is correct for empty streams!
  this.remaining = Infinity;
  this.cost = Infinity;
  this.costRemaining = Infinity;
  this.count = Infinity;
  this.matchRate = 1;
}
util.inherits(BindingStream, Stream);

// How many results there are on average per binding based on the given set of results or all results if no set was provided.
BindingStream.prototype.resultsPerBinding = function (results) {
  results = results || this.results;
  if (results.length === 0)
    return this._gotAllData ? 0 : Infinity;
  var sum = 0;
  for (var i = 0; i < results.length; ++i)
    sum += Math.max(1, results[i].count);
  return sum / results.length;
};

// Check if our average estimate is stable (95% certain assuming Gaussian distribution).
BindingStream.prototype.isStable = function () {
  if (this._gotAllData && this._bindings.length <= 0)
    return true;
  if (this.results.length < 4)
    return false;
  var prev = this.results[0];
  var prevAvg = this.resultsPerBinding(prev);
  var prevMargin = 0.98 / Math.sqrt(this.results.length) * prevAvg;
  var avg = this.resultsPerBinding();
  return prevMargin * prevAvg > Math.abs(prevAvg - avg);
};

// Download the metadata for the next stored bind value.
BindingStream.prototype.addBinding = function (callback) {
  var self = this;
  var bindingVal = this._bindings.shift();
  var binding = {};
  binding[this.bindVar] = bindingVal;
  var boundPattern = rdf.applyBindings(binding, this.pattern);
  var fragment = this._options.fragmentsClient.getFragmentByPattern(boundPattern);
  fragment.getProperty('metadata', function (metadata) {
    fragment.close();
    var stream = new DownloadStream(boundPattern, metadata.totalTriples, self._options);
    stream.bindVal = bindingVal;
    self._streams.push(stream);
    self.results.push({binding: bindingVal, count: metadata.totalTriples});
    self.resultVals.push(bindingVal);
    setImmediate(callback);
  });
};

// Add bindings untill the stream is stable (or there are no bindings left).
BindingStream.prototype.stabilize = function (callback) {
  if (this.isStable())
    return callback(true);
  if (this._bindings.length <= 0)
    return callback(false);

  var self = this;
  this.addBinding(function () { self.stabilize(callback); });
};

BindingStream.prototype.read = function (callback, _recursive) {
  if (this.ended || this._bindings.length === 0 && this._streams.length === 0)
    return setImmediate(function () { callback([]); });

  var self = this;
  // Always add at least 1 new binding if possible to update the stability.
  if ((!_recursive || !this.isStable() || this._streams.length === 0) && this._bindings.length > 0) {
    this.addBinding(function () { self.read(callback, true); });
  } else if (this._streams.length > 0) {
    var stream = this._streams[0];
    stream.read(function (buffer) {
      if (stream.ended)
        self._streams.shift();

      self.cost -= buffer.length;
      self.costRemaining = self.cost;
      if (self.remaining <= 0 && self._streams.length === 0 && self._bindings.length === 0)
        self.ended = true;

      self.triples = self.triples.concat(buffer);
      self.tripleCount += buffer.length;
      setImmediate(function () { callback(buffer); });
    });
  }
};

// Add new bind values.
BindingStream.prototype.feed = function (bindings) {
  // Don't add elements we already added before.
  var cacheExclude = {};
  var cache = {};
  var i;
  for (i = 0; i < this.resultVals.length; ++i)
    cacheExclude[this.resultVals[i]] = 1;
  for (i = 0; i < bindings.length; ++i)
    if (!cacheExclude[bindings[i]])
      cache[bindings[i]] = 1;
  for (i = 0; i < this._bindings.length; ++i)
    cache[this._bindings[i]] = 1;
  this._bindings = Object.keys(cache);
  this.logger.debug("FEED results: " + this.results.length + ", streams: " + this._streams.length + ", bindings: " + this._bindings.length + ", triples: " + this.tripleCount);
};

// Check if the stream needs new values to continue.
BindingStream.prototype.isHungry = function () {
  return this._streams.length === 0 && this._bindings.length === 0 && !this.ended;
};

// Update the stored estimates. 'remaining' is an estimate of how many values still need to be fed to the stream.
BindingStream.prototype.updateRemaining = function (remaining) {
  this.ended = this._bindings.length === 0 && _.every(this._streams, 'ended') && remaining === 0;
  this._gotAllData = remaining <= 0;

  if (!this.isStable()) {
    this.remaining = Infinity;
    this.cost = Infinity;
    this.costRemaining = Infinity;
    this.count = Infinity;
    return;
  }

  this.remaining = ClusteringUtil.sum(this._streams, 'remaining');
  this.remaining += (remaining + this._bindings.length) * this.resultsPerBinding();

  var oldCost = this.cost;
  this.cost = ClusteringUtil.sum(_.map(this._streams, function (stream) { return Math.ceil(stream.remaining / 100); })); // TODO: pagesize
  this.cost += (remaining + this._bindings.length) * Math.ceil(this.resultsPerBinding() / 100); // TODO: pageSize
  var diff = oldCost < Infinity ? this.cost - oldCost : 0;
  this.costRemaining = Math.min(this.cost, this.costRemaining + diff); // if cost suddenly increases, so should costRemaining (or lowers)

  this.count = ClusteringUtil.sum(_.pluck(this.results, 'count'));
  this.count += (remaining + this._bindings.length) * this.resultsPerBinding(); // _streams are already included in results

  this.matchRate = _.filter(this.results, function (result) { return result.count > 0; }).length / this.results.length;

  this.logger.debug("UPDATE remaining input:" + remaining + ", ended:" + this.ended + ", remaining:" + this.remaining + ", cost:" + this.cost + ", count:" + this.count + ", costRemaining:" + this.costRemaining + ", matchRate:" + this.matchRate);
};


module.exports = Stream;
Stream.DownloadStream = DownloadStream;
Stream.BindingStream = BindingStream;