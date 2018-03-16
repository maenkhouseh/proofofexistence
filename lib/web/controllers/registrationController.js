'use strict'

const config = require('config')
const core = require('../../core')
const store = require('../../store')
const blockcypher = require('../../clients/blockcypher')

const btc = config.get('currencies.btc')

const bitcore = require('bitcore-lib')
const _ = require('lodash')

const incomingHDPrivateKey = new bitcore.HDPrivateKey(btc.networks[btc.defaultNetwork].incomingPrivateKey)
const EXPECTED_CONFIRMATIONS = 1

const makeUnconfirmedHook = address => config.get('hostUrl') + '/unconfirmed/' + config.get('app.magicNumber') + '/' + address
const makeConfirmedHook = address => config.get('hostUrl') + '/confirmed/' + config.get('app.magicNumber') + '/' + address

/**
 * Register controller action.
 */

function create (req, res) {
  const hash = req.params.hash

  if (core.docproof.isValidDigest(req.params.hash)) {
    register(hash)
      .then(results => {
        res.json(results)
      }).catch(error => {
        console.log(error.message)

        res.status(500).end('Unexpected error')
      })
  } else {
    return res.status(400).json({
      reason: 'Invalid `hash` field'
    })
  }
}

/**
 * Perform a document registration.
 */

const register = async (hash) => {
  const docAddress = await store.getDigestAddress(hash)

  if (docAddress) {
    return existingRegistration(hash)
  } else {
    const randomPath = core.wallet.getRandomPath()
    const paymentAddress = incomingHDPrivateKey.derive(randomPath).privateKey.toAddress()

    const registration = newRegistration(hash, randomPath, paymentAddress)

    if (registration.fee > config.get('documentPrice')) {
      console.log('We should increase the price!', config.get('documentPrice'), 'vs', registration.fee)
      registration.fee = config.get('documentPrice') - 1
    }

    await store.putDigestAddress(hash, paymentAddress)
    await store.putDocproof(paymentAddress, registration)

    await blockcypher.createHook({
      event: 'unconfirmed-tx',
      address: paymentAddress.toString(),
      url: makeUnconfirmedHook(paymentAddress.toString())
    })

    await blockcypher.createHook({
      event: 'confirmed-tx',
      address: paymentAddress.toString(),
      confirmations: EXPECTED_CONFIRMATIONS,
      url: makeConfirmedHook(paymentAddress.toString())
    })

    const unconfirmed = _.omit(registration, 'path')
    store.addLatestUnconfirmed(unconfirmed)

    return paymentDetails(hash, paymentAddress)
  }
}

/**
 * Reply body if a document is already registered.
 */

function existingRegistration (hash) {
  return {
    'success': false,
    'reason': 'existing',
    'digest': hash
  }
}

/**
 * A new document registration.
 */

function newRegistration (hash, childKeyPath, address) {
  const feePerKilobyte = bitcore.Transaction.FEE_PER_KB
  const fee = core.docproof.estimateFee(feePerKilobyte, config.get('feeMultiplier'))

  return {
    digest: hash,
    path: childKeyPath,
    payment_address: address.toString(),
    pending: true,
    timestamp: new Date(),
    feePerKilobyte: feePerKilobyte,
    fee: fee
  }
}

/**
 * Reply body for a new registration.
 */

function paymentDetails (hash, address) {
  return {
    success: 'true',
    digest: hash,
    pay_address: address.toString(),
    price: config.get('documentPrice')
  }
}

module.exports = {
  create
}