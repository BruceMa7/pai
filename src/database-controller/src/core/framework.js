// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const logger = require('@dbc/core/logger')
const k8s = require('@dbc/core/k8s')
const _ = require('lodash')
const yaml = require('js-yaml')

const mockFrameworkStatus = () => {
  return {
    state: 'AttemptCreationPending',
    attemptStatus: {
      completionStatus: null,
      taskRoleStatuses: []
    },
    retryPolicyStatus: {
      retryDelaySec: null,
      totalRetriedCount: 0,
      accountableRetriedCount: 0
    }
  }
}

const convertState = (state, exitCode, retryDelaySec) => {
  switch (state) {
    case 'AttemptCreationPending':
    case 'AttemptCreationRequested':
    case 'AttemptPreparing':
      return 'WAITING'
    case 'AttemptRunning':
      return 'RUNNING'
    case 'AttemptDeletionPending':
    case 'AttemptDeletionRequested':
    case 'AttemptDeleting':
      if (exitCode === -210 || exitCode === -220) {
        return 'STOPPING'
      } else {
        return 'RUNNING'
      }
    case 'AttemptCompleted':
      if (retryDelaySec == null) {
        return 'RUNNING'
      } else {
        return 'WAITING'
      }
    case 'Completed':
      if (exitCode === 0) {
        return 'SUCCEEDED'
      } else if (exitCode === -210 || exitCode === -220) {
        return 'STOPPED'
      } else {
        return 'FAILED'
      }
    default:
      return 'UNKNOWN'
  }
}

function ignoreError (err) {
  logger.info('This error will be ignored: ', err)
}

class Snapshot {
  constructor (snapshot) {
    if (snapshot instanceof Object) {
      this._snapshot = _.cloneDeep(snapshot)
    } else {
      this._snapshot = JSON.parse(snapshot)
    }
    if (!this._snapshot.status) {
      this._snapshot.status = mockFrameworkStatus()
    }
  }

  copy () {
    return new Snapshot(this._snapshot)
  }

  getRequest (omitGeneration) {
    const request = _.pick(this._snapshot, [
      'apiVersion',
      'kind',
      'metadata.name',
      'metadata.labels',
      'metadata.annotations',
      'spec'
    ])
    if (omitGeneration) {
      return _.omit(request, 'metadata.annotations.requestGeneration')
    } else {
      return request
    }
  }

  overrideRequest (otherSnapshot) {
    // shouldn't use _.merge here
    _.assign(this._snapshot, _.pick(otherSnapshot._snapshot, [
      'apiVersion',
      'kind',
      'spec'
    ]))
    _.assign(this._snapshot.metadata, _.pick(otherSnapshot._snapshot.metadata, [
      'name',
      'labels',
      'annotations'
    ]))
  }

  getRequestUpdate (withSnapshot = true) {
    const loadedConfig = yaml.safeLoad(this._snapshot.metadata.annotations.config)
    const jobPriority = _.get(loadedConfig, 'extras.hivedscheduler.jobPriorityClass', null)
    const update = {
      name: this._snapshot.metadata.name,
      namespace: this._snapshot.metadata.namespace,
      jobName: this._snapshot.metadata.annotations.jobName,
      userName: this._snapshot.metadata.labels.userName,
      jobConfig: this._snapshot.metadata.annotations.config,
      executionType: this._snapshot.spec.executionType,
      virtualCluster: this._snapshot.metadata.labels.virtualCluster,
      jobPriority: jobPriority,
      totalGpuNumber: this._snapshot.metadata.annotations.totalGpuNumber,
      totalTaskNumber: this._snapshot.spec.taskRoles.reduce((num, spec) => num + spec.taskNumber, 0),
      totalTaskRoleNumber: this._snapshot.spec.taskRoles.length,
      logPathInfix: this._snapshot.metadata.annotations.logPathInfix
    }
    if (withSnapshot) {
      update.snapshot = JSON.stringify(this._snapshot)
    }
    return update
  }

  getStatusUpdate (withSnapshot = true) {
    const completionStatus = this._snapshot.status.attemptStatus.completionStatus
    const update = {
      retries: this._snapshot.status.retryPolicyStatus.totalRetriedCount,
      retryDelayTime: this._snapshot.status.retryPolicyStatus.retryDelaySec,
      platformRetries: this._snapshot.status.retryPolicyStatus.totalRetriedCount - this._snapshot.status.retryPolicyStatus.accountableRetriedCount,
      resourceRetries: 0,
      userRetries: this._snapshot.status.retryPolicyStatus.accountableRetriedCount,
      creationTime: this._snapshot.metadata.creationTimestamp ? new Date(this._snapshot.metadata.creationTimestamp) : null,
      completionTime: this._snapshot.status.completionTime ? new Date(this._snapshot.status.completionTime) : null,
      appExitCode: completionStatus ? completionStatus.code : null,
      subState: this._snapshot.status.state,
      state: convertState(
        this._snapshot.status.state,
        completionStatus ? completionStatus.code : null,
        this._snapshot.status.retryPolicyStatus.retryDelaySec
      )
    }
    if (withSnapshot) {
      update.snapshot = JSON.stringify(this._snapshot)
    }
    return update
  }

  getAllUpdate (withSnapshot = true) {
    const update = _.assign({}, this.getRequestUpdate(false), this.getStatusUpdate(false))
    if (withSnapshot) {
      update.snapshot = JSON.stringify(this._snapshot)
    }
    return update
  }

  getRecordForLegacyTransfer () {
    const record = this.getAllUpdate()
    // correct submissionTime is lost, use snapshot.metadata.creationTimestamp instead
    if (this.hasCreationTime()) {
      record.submissionTime = this.getCreationTime()
    } else {
      record.submissionTime = new Date()
    }
    this.setGeneration(1)
    return record
  }

  getName () {
    return this._snapshot.metadata.name
  }

  getSnapshot () {
    return _.cloneDeep(this._snapshot)
  }

  getString () {
    return JSON.stringify(this._snapshot)
  }

  hasCreationTime () {
    if (_.get(this._snapshot, 'metadata.creationTimestamp')) {
      return true
    } else {
      return false
    }
  }

  getCreationTime () {
    if (this.hasCreationTime()) {
      return new Date(this._snapshot.metadata.creationTimestamp)
    } else {
      return null
    }
  }

  setGeneration (generation) {
    this._snapshot.metadata.annotations.requestGeneration = (generation).toString()
  }

  getGeneration () {
    if (!_.has(this._snapshot, 'metadata.annotations.requestGeneration')) {
      // for some legacy jobs, use 1 as its request generation.
      this.setGeneration(1)
    }
    return parseInt(this._snapshot.metadata.annotations.requestGeneration)
  }
}

class AddOns {
  constructor (configSecretDef = null, priorityClassDef = null, dockerSecretDef = null) {
    if (configSecretDef !== null && !(configSecretDef instanceof Object)) {
      this._configSecretDef = JSON.parse(configSecretDef)
    } else {
      this._configSecretDef = configSecretDef
    }
    if (priorityClassDef !== null && !(priorityClassDef instanceof Object)) {
      this._priorityClassDef = JSON.parse(priorityClassDef)
    } else {
      this._priorityClassDef = priorityClassDef
    }
    if (dockerSecretDef !== null && !(dockerSecretDef instanceof Object)) {
      this._dockerSecretDef = JSON.parse(dockerSecretDef)
    } else {
      this._dockerSecretDef = dockerSecretDef
    }
  }

  async create () {
    if (this._configSecretDef) {
      try {
        await k8s.createSecret(this._configSecretDef)
      } catch (err) {
        if (err.response && err.response.statusCode === 409) {
          logger.warn(`Secret ${this._configSecretDef.metadata.name} already exists.`)
        } else {
          throw err
        }
      }
    }
    if (this._priorityClassDef) {
      try {
        await k8s.createPriorityClass(this._priorityClassDef)
      } catch (err) {
        if (err.response && err.response.statusCode === 409) {
          logger.warn(`PriorityClass ${this._priorityClassDef.metadata.name} already exists.`)
        } else {
          throw err
        }
      }
    }
    if (this._dockerSecretDef) {
      try {
        await k8s.createSecret(this._dockerSecretDef)
      } catch (err) {
        if (err.response && err.response.statusCode === 409) {
          logger.warn(`Secret ${this._dockerSecretDef.metadata.name} already exists.`)
        } else {
          throw err
        }
      }
    }
  }

  silentPatch (frameworkResponse) {
    // do not await for patch
    this._configSecretDef && k8s.patchSecretOwnerToFramework(this._configSecretDef, frameworkResponse).catch(ignoreError)
    this._dockerSecretDef && k8s.patchSecretOwnerToFramework(this._dockerSecretDef, frameworkResponse).catch(ignoreError)
  }

  silentDelete () {
    // do not await for delete
    this._configSecretDef && k8s.deleteSecret(this._configSecretDef.metadata.name).catch(ignoreError)
    this._priorityClassDef && k8s.deletePriorityClass(this._priorityClassDef.metadata.name).catch(ignoreError)
    this._dockerSecretDef && k8s.deleteSecret(this._dockerSecretDef.metadata.name).catch(ignoreError)
  }

  getUpdate () {
    const update = {}
    if (this._configSecretDef) {
      update.configSecretDef = JSON.stringify(this._configSecretDef)
    }
    if (this._priorityClassDef) {
      update.priorityClassDef = JSON.stringify(this._priorityClassDef)
    }
    if (this._dockerSecretDef) {
      update.dockerSecretDef = JSON.stringify(this._dockerSecretDef)
    }
    return update
  }
}

async function synchronizeCreate (snapshot, addOns) {
  await addOns.create()
  try {
    const response = await k8s.createFramework(snapshot.getRequest(false))
    // framework is created successfully.
    const frameworkResponse = response.body
    addOns.silentPatch(frameworkResponse)
    return frameworkResponse
  } catch (err) {
    if (err.response && err.response.statusCode === 409) {
      // doesn't delete add-ons if 409 error
      logger.warn(`Framework ${snapshot.getName()} already exists.`)
      throw err
    } else {
      // delete add-ons if 409 error
      addOns.silentDelete()
      throw err
    }
  }
}

async function synchronizeModify (snapshot) {
  const response = await k8s.patchFramework(snapshot.getName(), snapshot.getRequest(false))
  const frameworkResponse = response.body
  return frameworkResponse
}

async function synchronizeRequest (snapshot, addOns) {
  // any error will be raised
  // if succeed, return framework from api server
  // There may be multiple calls of synchronizeRequest.
  try {
    await k8s.getFramework(snapshot.getName())
    // if framework exists
    const frameworkResponse = await synchronizeModify(snapshot)
    logger.info(`Request of framework ${snapshot.getName()} is successfully patched.`)
    return frameworkResponse
  } catch (err) {
    if (err.response && err.response.statusCode === 404) {
      const frameworkResponse = await synchronizeCreate(snapshot, addOns)
      logger.info(`Request of framework ${snapshot.getName()} is successfully created.`)
      return frameworkResponse
    } else {
      throw err
    }
  }
}

function silentSynchronizeRequest (snapshot, addOns) {
  // any error will be ignored
  synchronizeRequest(snapshot, addOns).catch(ignoreError)
}

module.exports = {
  Snapshot,
  AddOns,
  synchronizeRequest,
  silentSynchronizeRequest
}
