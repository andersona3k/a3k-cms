'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

function signToken(user) {
  const payload = {
    sub: user.id,
    company_id: user.company_id,
    role_id: user.role_id,
    email: user.email,
  };
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

module.exports = { signToken, verifyToken };
