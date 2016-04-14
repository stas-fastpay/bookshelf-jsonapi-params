// Load modules

import {
    assign as _assign,
    find as _find,
    forEach as _forEach,
    has as _has,
    includes as _includes,
    isEmpty as _isEmpty,
    isArray as _isArray,
    isObject as _isObject,
    isObjectLike as _isObjectLike,
    isUndefined as _isUndefined,
    keys as _keys,
    zipObject as _zipObject
} from 'lodash';

import Paginator from 'bookshelf-page';

/**
 * Exports a plugin to pass into the bookshelf instance, i.e.:
 *
 *      import config from './knexfile';
 *      import knex from 'knex';
 *      import bookshelf from 'bookshelf';
 *
 *      const Bookshelf = bookshelf(knex(config));
 *
 *      Bookshelf.plugin('bookshelf-jsonapi-params');
 *
 *      export default Bookshelf;
 *
 * The plugin attaches the `fetchJsonApi` instance method to
 * the Bookshelf Model object.
 *
 * See methods below for details.
 */
export default (Bookshelf, options = {}) => {

    // Load the pagination plugin
    Bookshelf.plugin(Paginator);

    /**
     * Similar to {@link Model#fetch} and {@link Model#fetchAll}, but specifically
     * uses parameters defined by the {@link https://jsonapi.org|JSON API spec} to
     * build a query to further refine a result set.
     *
     * @param  opts {object}
     *     Currently supports the `include`, `fields`, `sort`, `page` and `filter`
     *     parameters from the {@link https://jsonapi.org|JSON API spec}.
     * @param  type {string}
     *     An optional string that specifies the type of resource being retrieved.
     *     If not specified, type will default to the name of the table associated
     *     with the model.
     * @return {Promise<Model|Collection|null>}
     */
    const fetchJsonApi = function (opts = {}, type) {

        const internals = {};
        const { include, fields, sort, page = {}, filter } = opts;

        // Get a reference to the field being used as the id
        internals.idAttribute = this.constructor.prototype.idAttribute ?
            this.constructor.prototype.idAttribute : 'id';

        // Get a reference to the current model name. Note that if no type is
        // explcitly passed, the tableName will be used
        internals.modelName = type ? type : this.constructor.prototype.tableName;

        // Initialize an instance of the current model and clone the initial query
        internals.model =
            this.constructor.forge().query((qb) => _assign(qb, this.query().clone()));

        // Currently, there isn't a great way to determine whether the incoming query
        // will return a Model or Collection. This is problematic in that always calling
        // fetchAll will have an effect on how the JSONAPI response is formatted. Until
        // then, we'll do some criteria checking that should work for most cases.
        internals.isCollection = () => {

            const criteria = this.query()._statements;

            // If attributes were passed (as a result of `forge({some data})`)
            // or there `id` was specified in the criteria, then assume we're looking
            // for a specific model. Otherwise, it's a collection.
            if (!_isEmpty(this.attributes) ||
                !_isUndefined(_find(criteria, ['column', internals.idAttribute]))) {
                return false;
            }

            return true;
        };

        /**
         * Build a query based on the `fields` parameter.
         * @param  fieldNames {object}
         */
        internals.buildFields = (fieldNames = {}) => {

            if (_isObject(fieldNames) && !_isEmpty(fieldNames)) {

                // Format column names
                fieldNames = internals.formatColumnNames(fieldNames);

                // Process fields for each type/relation
                _forEach(fieldNames, (value, key) => {

                    // Only process the field if it's not a relation. Fields
                    // for relations are processed in `buildIncludes()`
                    if (!_includes(include, key)) {

                        // Add column to query
                        internals.model.query((qb) => {

                            qb.column.apply(qb, [value]);

                            // JSON API considers relationships as fields, so we
                            // need to make sure the id of the relation is selected
                            _forEach(include, (relation) => {

                                const relationId = `${relation}_id`;

                                if (!internals.isManyRelation(relation) &&
                                    !_includes(fieldNames[relation], relationId)) {
                                    qb.column.apply(qb, [relationId]);
                                }
                            });
                        });
                    }
                });
            }
        };

        /**
         * Build a query based on the `filters` parameter.
         * @param  filterValues {object|array}
         */
        internals.buildFilters = (filterValues) => {

            if (_isObjectLike(filterValues) && !_isEmpty(filterValues)) {

                // format the column names of the filters
                filterValues = this.format(filterValues);

                // build the filter query
                internals.model.query((qb) => {

                    qb.where.apply(qb, [filterValues]);
                });
            }
        };

        /**
         * Build a query based on the `include` parameter.
         * @param  includeValues {array}
         */
        internals.buildIncludes = (includeValues) => {

            if (_isArray(includeValues) && !_isEmpty(includeValues)) {

                const relations = [];

                _forEach(includeValues, (relation) => {

                    if (_has(fields, relation)) {

                        const fieldNames = internals.formatColumnNames(fields);

                        relations.push({
                            [relation]: (qb) => {

                                const relationId = `${internals.modelName}_id`;

                                if (!internals.isBelongsToRelation(relation) &&
                                    !_includes(fieldNames[relation], relationId)) {

                                    qb.column.apply(qb, [relationId]);
                                }

                                qb.column.apply(qb, [fieldNames[relation]]);
                            }
                        });
                    }
                    else {
                        relations.push(relation);
                    }
                });

                _assign(opts, { withRelated: relations });
            }
        };

        /**
         * Build a query based on the `sort` parameter.
         * @param  sortValues {array}
         */
        internals.buildSort = (sortValues = []) => {

            if (_isArray(sortValues) && !_isEmpty(sortValues)) {

                sortValues = internals.formatColumnNames(sortValues);

                _forEach(sortValues, (sortBy) => {

                    internals.model.orderBy(sortBy);
                });
            }
        };

        /**
         * Processes incoming parameters that represent columns names and
         * formats them using the internal {@link Model#format} function.
         * @param  columnNames {array}
         * @return {array{}
         */
        internals.formatColumnNames = (columnNames = []) => {

            _forEach(columnNames, (value, key) => {

                let columns;

                // Convert column names to an object so it can
                // be passed to Model#format
                if (_isArray(columnNames[key])) {
                    columns = _zipObject(columnNames[key], null);
                }
                else {
                    columns = _zipObject(columnNames, null);
                }

                // Re-add idAttribute as it's required by the JSONAPI spec
                columns[internals.idAttribute] = null;

                // Format column names using Model#format
                if (_isArray(columnNames[key])) {
                    columnNames[key] = _keys(this.format(columns));
                }
                else {
                    columnNames = _keys(this.format(columns));
                }
            });

            return columnNames;
        };

        /**
         * Determines if the specified relation is a `belongsTo` type.
         * @param  relationName {string}
         * @return {boolean}
         */
        internals.isBelongsToRelation = (relationName) => {

            const relationType = this.related(relationName).relatedData.type.toLowerCase();

            if (relationType !== undefined &&
                relationType === 'belongsto') {

                return true;
            }

            return false;
        };

        /**
         * Determines if the specified relation is a `many` type.
         * @param  relationName {string}
         * @return {boolean}
         */
        internals.isManyRelation = (relationName) => {

            const relationType = this.related(relationName).relatedData.type.toLowerCase();

            if (relationType !== undefined &&
                relationType.indexOf('many') > 0) {

                return true;
            }

            return false;
        };

        ////////////////////////////////
        /// Process parameters
        ////////////////////////////////

        // Apply filters
        internals.buildFilters(filter);

        // Apply sparse fieldsets
        internals.buildFields(fields);

        // Apply sorting
        internals.buildSort(sort);

        // Apply relations
        internals.buildIncludes(include);

        // Assign default paging options if they were passed to the plugin
        // and no pagination parameters were passed directly to the method.
        if (internals.isCollection() &&
            _isEmpty(page) &&
            _has(options, 'pagination')) {

            _assign(page, options.pagination);
        }

        // Apply paging
        if (internals.isCollection() &&
            _isObject(page) &&
            !_isEmpty(page)) {

            const pageOptions = _assign(opts, page);

            return internals.model.fetchPage(pageOptions);
        }

        // Determine whether to return a Collection or Model

        // Call `fetchAll` to return Collection
        if (internals.isCollection()) {
            return internals.model.fetchAll(opts);
        }

        // Otherwise, call `fetch` to return Model
        return internals.model.fetch(opts);
    };

    // Add `fetchJsonApi()` method to Bookshelf Model/Collection prototypes
    Bookshelf.Model.prototype.fetchJsonApi = fetchJsonApi;

    Bookshelf.Model.fetchJsonApi = function (...args) {

        return this.forge().fetchJsonApi(...args);
    };

    Bookshelf.Collection.prototype.fetchJsonApi = function (...args) {

        return fetchJsonApi.apply(this.model.forge(), ...args);
    };
};
