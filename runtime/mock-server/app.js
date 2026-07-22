'use strict';

const express = require('express');
const path = require('path');
const { applyCorsHeaders, handleOptions } = require('../../lib/cors');
const createRouter = require('./router');

/**
 * Create mock express app.
 * @param {{ mocksRoot: string, cors?: object, caseHeader?: string }} opts
 */
function createMockApp(opts) {
  const {
    mocksRoot,
    cors = {},
    caseHeader = 'x-mock-case',
    resolveMocksRoot = null,
    mode = 'mock-lab',
    serveCaptureIfEmpty = false,
    capturesDir = null,
  } = opts;
  const app = express();

  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      return handleOptions(req, res, cors);
    }
    applyCorsHeaders(req, res, cors);
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '10mb' }));

  app.use(
    '/',
    createRouter({
      mocksRoot,
      caseHeader,
      resolveMocksRoot,
      mode,
      serveCaptureIfEmpty,
      capturesDir,
    }),
  );

  app.use((req, res) => {
    applyCorsHeaders(req, res, cors);
    res.status(404).json({
      code: 404,
      message: `mock not found: ${req.method} ${req.path}`,
      data: null,
    });
  });

  app.use((err, req, res, _next) => {
    applyCorsHeaders(req, res, cors);
    res.status(500).json({
      code: 500,
      message: err.message || 'mock server error',
      data: null,
    });
  });

  return app;
}

module.exports = { createMockApp, applyCorsHeaders };
