'use strict';

var EventEmitter = require('events').EventEmitter,
    Transform = require('stream').Transform,
    util = require('util'),
    assert = require('assert'),
    _ = require('lodash');

function myTransform(opts) {
    Transform.call(this, opts);
}
util.inherits(myTransform, Transform);

util.inherits(ElasticsearchTransform, myTransform);

/**
 * Transform records into a format required by Elasticsearch bulk API
 *
 * @private
 * @param {array} records
 * @return {array}
 */
function transformRecords(records) {
    return records.reduce(function(bulkOperations, record) {
        var operation = {};

        operation[record.action] = {
            _index: record.index,
            _type: record.type,
            _id: record.id
        };

        if (record.parent) {
            operation[record.action]._parent = record.parent;
        }

        bulkOperations.push(operation);

        if (record.action !== 'delete') {
            bulkOperations.push(record.body);
        }

        return bulkOperations;
    }, []);
}

/**
 * Validate incoming operations, ensuring they have all relevant fields defined.
 *
 * @private
 * @param {object} operation
 * @return {object}
 */
function validateOperation(operation) {
    assert(operation.index, 'index is required');
    assert(operation.type, 'type is required');

    operation.action = operation.action || 'index';

    if (operation.action !== 'delete') {
        assert(operation.body, 'body is required');

        if (operation.action === 'update_by_query') {
            assert(operation.body.script, 'body.script is required');
            assert(operation.body.query, 'body.query is required');
        }
    }

    return operation;
}

/**
 * A simple wrapper around Elasticsearch for bulk writing items
 *
 * @param {Elasticsearch.Client} client Elasticsearch client
 * @param {Object} options Options
 * @param {number} [options.highWaterMark=16] Number of items to buffer before writing.
 * Also the size of the underlying stream buffer.
 * @param {number} [options.flushTimeout=null] Number of ms to flush records after, if highWaterMark hasn't been reached
 * @param {Object} [options.logger] Instance of a logger like bunyan or winston
 */
function ElasticsearchTransform(client, options) {
    assert(client, 'client is required');

    options = options || {};
    options.objectMode = true;

    myTransform.call(this, options);

    this.client = client;
    this.logger = options.logger || null;

    this.highWaterMark = options.highWaterMark || 16;
    this.flushTimeout = options.flushTimeout || null;
    this.writtenRecords = 0;
    this.queue = [];
}

/**
 * Bulk write records to Elasticsearch
 *
 * @private
 * @param {array} records
 * @param {Function} callback
 */
ElasticsearchTransform.prototype.bulkWrite = function bulkWrite(records, callback) {
    this.client.bulk({ body: records }, function bulkCallback(err, data) {
        var combineObj;
        var zipped;
        if (err) {

            if (this.logger) {
                this.logger.error('err', err)
            }

            err.records = records;

            return callback(err);
        }

        if (data.errors === true) {
            if (this.logger) {
                this.logger.error('data.errors', data.errors)
            }

            var errors = _.chain(data.items)
                .map(function(item) {
                    return _.map(item, 'error')[0];
                })
                .filter(_.isString)
                .uniq()
                .value();

            var error = new Error(errors);
            error.records = records;

            return callback(error);
        } else {
            combineObj = {
                response: data,
                records: records.filter((value) => {
                    return !value.hasOwnProperty('index'); //filter out action objs see: https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/api-reference.html#api-bulk
                })
            }

            zipped = combineObj.records.map(function(val, i) {
                return Object.assign(val, combineObj.response.items[i].index)
            })
            zipped.forEach(function(val) {
                this.push(val);
            }, this)
        }

        callback();
    }.bind(this));
};

/**
 * Bulk update records in Elasticsearch using UpdateByQuery
 *
 * @private
 * @param {object} operation
 * @param {Function} callback
 */
ElasticsearchTransform.prototype.partialUpdate = function partialUpdate(operation, callback) {
    if (this.logger) {
        this.logger.debug('Executing update_by_query in Elasticsearch');
    }

    var op = _.cloneDeep(operation);
    delete op.action;

    this.client.updateByQuery(op, function bulkCallback(err, data) {
        if (err) {
            err.operation = operation;
            return callback(err);
        }

        if (data.failures.length !== 0) {
            if (this.logger) {
                data.failures.forEach(this.logger.error.bind(this.logger));
            }

            var error = new Error('One or more failures occurred during update_by_query.');
            error.operation = operation;

            return callback(error);
        }

        if (this.logger) {
            this.logger.verbose('Updated %d records (via update_by_query) in Elasticsearch', data.updated);
        }

        this.writtenRecords += data.updated;

        callback(null, data);
    }.bind(this));
};

/**
 * Flush method needed by the underlying stream implementation
 *
 * @private
 * @param {Function} callback
 * @return {undefined}
 */
ElasticsearchTransform.prototype._flush = function _flush(callback) {
    clearTimeout(this.flushTimeoutId);

    if (this.queue.length === 0) {
        return callback();
    }

    try {
        var records = transformRecords(this.queue);
    } catch (error) {
        return callback(error);
    }

    var recordsCount = this.queue.length;
    this.queue = [];

    if (this.logger) {
        this.logger.debug('Writing %d records to Elasticsearch', recordsCount);
    }

    this.bulkWrite(records, function(err) {
        if (err) {
            return callback(err);
        }

        if (this.logger) {
            this.logger.verbose('Wrote %d records to Elasticsearch', recordsCount);
        }

        this.writtenRecords += recordsCount;

        callback();
    }.bind(this));
};

/**
 * Write method needed by the underlying stream implementation
 *
 * @private
 * @param {Object} record
 * @param {string} enc
 * @param {Function} callback
 * @returns {undefined}
 */
ElasticsearchTransform.prototype._transform = function _transform(record, enc, callback) {
    if (record.hasOwnProperty('do')) {
        return callback();
    }

    if (this.logger) {
        this.logger.debug('Adding to Elasticsearch queue', { record: record });
    }

    try {
        validateOperation(record);
    } catch (error) {
        return callback(error);
    }

    if (record.action === 'update_by_query') {
        return this.partialUpdate(record, callback);
    }

    this.queue.push(record);

    if (this.queue.length >= this.highWaterMark) {
        return this._flush(callback);
    } else if (this.flushTimeout) {
        clearTimeout(this.flushTimeoutId);

        this.flushTimeoutId = setTimeout(function() {
            this._flush(function(err) {
                if (err) {
                    this.emit('error', err);
                }
            }.bind(this));
        }.bind(this), this.flushTimeout);
    }

    callback();
};

module.exports = ElasticsearchTransform;