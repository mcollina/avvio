'use strict'

const fastq = require('fastq')
const EE = require('events').EventEmitter
const inherits = require('util').inherits
const TimeTree = require('./time-tree')
const Plugin = require('./plugin')
const debug = require('debug')('avvio')

function wrap (server, opts, instance) {
  const expose = opts.expose || {}
  const useKey = expose.use || 'use'
  const afterKey = expose.after || 'after'
  const readyKey = expose.ready || 'ready'
  const onCloseKey = expose.onClose || 'onClose'
  const closeKey = expose.close || 'close'

  if (server[useKey]) {
    throw new Error(useKey + '() is already defined, specify an expose option')
  }

  if (server[afterKey]) {
    throw new Error(afterKey + '() is already defined, specify an expose option')
  }

  if (server[readyKey]) {
    throw new Error(readyKey + '() is already defined, specify an expose option')
  }

  server[useKey] = function (a, b, c) {
    instance.use(a, b, c)
    return this
  }

  server[afterKey] = function (func) {
    if (typeof func !== 'function') {
      throw new Error('not a function')
    }
    instance.after(encapsulateThreeParam(func, this))
    return this
  }

  server[readyKey] = function (func) {
    if (func && typeof func !== 'function') {
      throw new Error('not a function')
    }
    return instance.ready(func ? encapsulateThreeParam(func, this) : undefined)
  }

  server[onCloseKey] = function (func) {
    if (typeof func !== 'function') {
      throw new Error('not a function')
    }
    instance.onClose(encapsulateTwoParam(func, this))
    return this
  }

  server[closeKey] = function (func) {
    if (func && typeof func !== 'function') {
      throw new Error('not a function')
    }

    if (func) {
      instance.close(encapsulateThreeParam(func, this))
      return this
    }

    // this is a Promise
    return instance.close()
  }
}

function Boot (server, opts, done) {
  if (typeof server === 'function' && arguments.length === 1) {
    done = server
    opts = {}
    server = null
  }

  if (typeof opts === 'function') {
    done = opts
    opts = {}
  }

  opts = opts || {}

  if (!(this instanceof Boot)) {
    const instance = new Boot(server, opts, done)

    if (server) {
      wrap(server, opts, instance)
    }

    return instance
  }

  if (opts.autostart !== false) {
    opts.autostart = true
  }

  server = server || this

  this._timeout = Number(opts.timeout) || 0
  this._server = server
  this._current = []
  this._error = null
  this._isOnCloseHandlerKey = Symbol('isOnCloseHandler')

  this.setMaxListeners(0)

  if (done) {
    this.once('start', done)
  }

  this.started = false
  this.booted = false
  this.pluginTree = new TimeTree()

  this._readyQ = fastq(this, callWithCbOrNextTick, 1)
  this._readyQ.pause()
  this._readyQ.drain = () => {
    this.emit('start')
    // nooping this, we want to emit start only once
    this._readyQ.drain = noop
  }

  this._closeQ = fastq(this, closeWithCbOrNextTick, 1)
  this._closeQ.pause()
  this._closeQ.drain = () => {
    this.emit('close')
    // nooping this, we want to emit start only once
    this._closeQ.drain = noop
  }

  this._doStart = null
  const main = new Plugin(this, root.bind(this), opts, noop, 0)

  main.once('start', (serverName, funcName, time) => {
    const nodeId = this.pluginTree.start(null, funcName, time)
    main.once('loaded', (serverName, funcName, time) => {
      this.pluginTree.stop(nodeId, time)
    })
  })

  Plugin.loadPlugin.call(this, main, (err) => {
    debug('root plugin ready')
    this.emit('preReady')
    if (err) {
      this._error = err
      if (this._readyQ.length() === 0) {
        throw err
      }
    } else {
      this.booted = true
      this._readyQ.resume()
    }
  })
}

function root (s, opts, done) {
  this._doStart = done
  if (opts.autostart) {
    this.start()
  }
}

inherits(Boot, EE)

Boot.prototype.start = function () {
  this.started = true

  // we need to wait any call to use() to happen
  process.nextTick(this._doStart)
  return this
}

// allows to override the instance of a server, given a plugin
Boot.prototype.override = function (server, func, opts) {
  return server
}

// load a plugin
Boot.prototype.use = function (plugin, opts) {
  if (typeof plugin === 'function') {
    this._addPlugin(plugin, opts, false)
  } else {
    throw new Error('plugin must be a function')
  }

  return this
}

Boot.prototype._addPlugin = function (plugin, opts, isAfter) {
  if (typeof plugin !== 'function') {
    throw new Error('plugin must be a function')
  }
  opts = opts || {}

  if (this.booted) {
    throw new Error('root plugin has already booted')
  }

  const pluginMeta = plugin[Symbol.for('plugin-meta')]
  if (pluginMeta && typeof pluginMeta.onRegister === 'function') {
    pluginMeta.onRegister(this._server, opts)
  }

  // we always add plugins to load at the current element
  const current = this._current[0]

  const obj = new Plugin(this, plugin, opts, isAfter)
  obj.once('start', (serverName, funcName, time) => {
    const nodeId = this.pluginTree.start(current.name, funcName, time)
    obj.once('loaded', (serverName, funcName, time) => {
      this.pluginTree.stop(nodeId, time)
    })
  })

  if (current.loaded) {
    throw new Error(`Impossible to load "${obj.name}" plugin because the parent "${current.name}" was already loaded`)
  }

  // we add the plugin to be loaded at the end of the current queue
  current.enqueue(obj, (err) => {
    if (err) {
      this._error = err
    }
  })
}

Boot.prototype.after = function (func) {
  this._addPlugin(_after.bind(this), {}, true)

  function _after (s, opts, done) {
    callWithCbOrNextTick.call(this, func, done)
  }

  return this
}

Boot.prototype.onClose = function (func) {
  // this is used to distinguish between onClose and close handlers
  // because they share the same queue but must be called with different signatures

  if (typeof func !== 'function') {
    throw new Error('not a function')
  }

  func[this._isOnCloseHandlerKey] = true
  this._closeQ.unshift(func, callback.bind(this))

  function callback (err) {
    if (err) this._error = err
  }

  return this
}

Boot.prototype.close = function (func) {
  var promise

  if (func) {
    if (typeof func !== 'function') {
      throw new Error('not a function')
    }
  } else {
    promise = new Promise(function (resolve, reject) {
      func = function (err) {
        if (err) {
          return reject(err)
        }
        resolve()
      }
    })
  }

  this.ready(() => {
    this._error = null
    this._closeQ.push(func)
    process.nextTick(this._closeQ.resume.bind(this._closeQ))
  })

  return promise
}

Boot.prototype.ready = function (func) {
  if (func) {
    if (typeof func !== 'function') {
      throw new Error('not a function')
    }
    this._readyQ.push(func)
    this.start()
    return
  }

  return new Promise((resolve, reject) => {
    this._readyQ.push(readyPromiseCB)
    this.start()

    function readyPromiseCB (err, context, done) {
      if (err) {
        reject(err)
      } else {
        resolve(context)
      }
      process.nextTick(done)
    }
  })
}

Boot.prototype.prettyPrint = function () {
  return this.pluginTree.prittyPrint()
}

Boot.prototype.toJSON = function () {
  return this.pluginTree.toJSON()
}

function noop () { }

function callWithCbOrNextTick (func, cb, context) {
  context = this._server
  var err = this._error
  var res

  // with this the error will appear just in the next after/ready callback
  this._error = null
  if (func.length === 0) {
    this._error = err
    res = func()
    if (res && typeof res.then === 'function') {
      res.then(() => process.nextTick(cb), (e) => process.nextTick(cb, e))
    } else {
      process.nextTick(cb)
    }
  } else if (func.length === 1) {
    res = func(err)
    if (res && typeof res.then === 'function') {
      res.then(() => process.nextTick(cb), (e) => process.nextTick(cb, e))
    } else {
      process.nextTick(cb)
    }
  } else if (func.length === 2) {
    func(err, cb)
  } else {
    func(err, context, cb)
  }
}

function closeWithCbOrNextTick (func, cb, context) {
  context = this._server
  var isOnCloseHandler = func[this._isOnCloseHandlerKey]
  if (func.length === 0 || func.length === 1) {
    var promise
    if (isOnCloseHandler) {
      promise = func(context)
    } else {
      promise = func(this._error)
    }
    if (promise && typeof promise.then === 'function') {
      debug('resolving close/onClose promise')
      promise.then(
        () => process.nextTick(cb),
        (e) => process.nextTick(cb, e))
    } else {
      process.nextTick(cb)
    }
  } else if (func.length === 2) {
    if (isOnCloseHandler) {
      func(context, cb)
    } else {
      func(this._error, cb)
    }
  } else {
    if (isOnCloseHandler) {
      func(context, cb)
    } else {
      func(this._error, context, cb)
    }
  }
}

function encapsulateTwoParam (func, that) {
  return _encapsulateTwoParam.bind(that)
  function _encapsulateTwoParam (context, cb) {
    if (func.length === 0) {
      func()
      process.nextTick(cb)
    } else if (func.length === 1) {
      func(cb)
    } else {
      func(this, cb)
    }
  }
}

function encapsulateThreeParam (func, that) {
  return _encapsulateThreeParam.bind(that)
  function _encapsulateThreeParam (err, cb) {
    var res
    if (!func) {
      process.nextTick(cb)
    } else if (func.length === 0) {
      res = func()
      if (res && res.then) {
        res.then(function () {
          process.nextTick(cb, err)
        }, cb)
      } else {
        process.nextTick(cb, err)
      }
    } else if (func.length === 1) {
      res = func(err)
      if (res && res.then) {
        res.then(function () {
          process.nextTick(cb)
        }, cb)
      } else {
        process.nextTick(cb)
      }
    } else if (func.length === 2) {
      func(err, cb)
    } else {
      func(err, this, cb)
    }
  }
}

module.exports = Boot
module.exports.express = function (app) {
  return Boot(app, {
    expose: {
      use: 'load'
    }
  })
}
