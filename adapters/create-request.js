'use strict';

/**
 * Optional adapter: createRequest({ key }) extraction.
 *
 * Interface (contract for custom adapters):
 *   module.exports = {
 *     name: 'create-request',
 *     extract({ content, rel, serviceBases }) -> Api[]
 *   }
 *
 * Load via: mox init --adapter=create-request
 * Built-in infer already runs createRequest + fetch/axios by default;
 * --adapter adds (or re-runs) a named extractor from adapters/*.js.
 */

const { extractCreateRequestApis } = require('../lib/infer/extract-create-request');

module.exports = {
  name: 'create-request',
  extract({ content, rel, serviceBases }) {
    return extractCreateRequestApis(content, rel, serviceBases);
  },
};
