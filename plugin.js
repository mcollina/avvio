'use strict'

const fastq = require('fastq')
const debug = require('debug')('avvio')
const CODE_PLUGIN_TIMEOUT = 'ERR_AVVIO_PLUGIN_TIMEOUT'

function getName (func) {
  // let's see if this is a file, and in that case use that
  // this is common for plugins
  const cache = require.cache
  const keys = Object.keys(cache)

  for (var i = 0; i < keys.length; i++) {
    if (cache[keys[i]].exports === func) {
      return keys[i]
    }
  }

  // if not maybe it's a named function, so use that
  if (func.name) {
    return func.name
  }

  // takes the first two lines of the function if nothing else works
  return func.toString().split('\n').slice(0, 2).map(s => s.trim()).join(' -- ')
}

function Plugin (parent, func, opts, isAfter, timeout) {
  this.func = func
  this.opts = opts
  this.deferred = false
  this.onFinish = null
  this.parent = parent
  this.timeout = timeout === undefined ? parent._timeout : timeout
  this.name = getName(func)
  this.isAfter = isAfter

  this.q = fastq(parent, loadPlugin, 1)
  this.q.pause()
  this.loaded = false

  // always start the queue in the next tick
  // because we try to attach subsequent call to use()
  // to the right plugin. we need to defer them,
  // or they will end up at the top of _current
}

Plugin.prototype.exec = function (server, cb) {
  const func = this.func
  var completed = false
  var name = this.name

  if (this.parent._error && !this.isAfter) {
    debug('skipping loading of plugin as parent errored and it is not an after', name)
    process.nextTick(cb)
    return
  }

  try {
    this.server = this.parent.override(server, func, this.opts)
  } catch (err) {
    debug('override errored', name)
    return cb(err)
  }

  debug('exec', name)

  var timer

  if (this.timeout > 0) {
    debug('setting up timeout', name, this.timeout)
    timer = setTimeout(function () {
      debug('timed out', name)
      timer = null
      const err = new Error(`${CODE_PLUGIN_TIMEOUT}: plugin did not start in time: ${name}`)
      err.code = CODE_PLUGIN_TIMEOUT
      err.fn = func
      done(err)
    }, this.timeout)
  }

  var promise = func.call(this.server, this.server, this.opts, done)
  if (promise && typeof promise.then === 'function') {
    debug('resolving promise', name)
    promise.then(
      () => process.nextTick(done),
      (e) => process.nextTick(done, e))
  }

  function done (err) {
    if (completed) {
      debug('loading complete', name)
      return
    }

    if (err) {
      debug('exec errored', name)
    } else {
      debug('exec completed', name)
    }

    completed = true

    if (timer) {
      clearTimeout(timer)
    }

    cb(err)
  }
}

Plugin.prototype.enqueue = function (obj, cb) {
  debug('enqueue', this.name, obj.name)
  this.q.push(obj, cb)
}

Plugin.prototype.finish = function (err, cb) {
  debug('finish', this.name)
  const done = () => {
    if (this.loaded) {
      return
    }

    debug('loaded', this.name)
    this.loaded = true

    cb(err)
  }

  if (err) {
    done()
    return
  }

  const check = () => {
    debug('check', this.name, this.q.length(), this.q.running())
    if (this.q.length() === 0 && this.q.running() === 0) {
      done()
    } else {
      debug('delayed', this.name)
      // finish when the queue of nested plugins to load is empty
      this.q.drain = () => {
        debug('drain', this.name)
        this.q.drain = noop

        // we defer the check, as a safety net for things
        // that might be scheduled in the loading callback
        process.nextTick(check)
      }
    }
  }

  process.nextTick(check)

  // we start loading the dependents plugins only once
  // the current level is finished
  this.q.resume()
}

// loads a plugin
function loadPlugin (toLoad, cb) {
  const last = this._current[0]
  // place the plugin at the top of _current
  this._current.unshift(toLoad)

  toLoad.exec((last && last.server) || this._server, (err) => {
    toLoad.finish(err, (err) => {
      this._current.shift()
      cb(err)
    })
  })
}

function noop () {}

module.exports = Plugin
module.exports.loadPlugin = loadPlugin
