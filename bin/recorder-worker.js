'use strict'

const path = require('path')
const { workerData } = require('worker_threads')

if (workerData.dev) {
  const { register, require: tsxRequire } = require('tsx/cjs/api')
  register()
  tsxRequire(path.join(workerData.rootDir, 'backend/src/recorder/worker.ts'), __filename)
} else {
  require(path.join(workerData.rootDir, 'dist/recorder/worker.js'))
}

