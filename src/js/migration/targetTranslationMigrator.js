'use strict';

;(function () {

    let _ = require('lodash'),
        path = require('path'),
        fs = require('fs'),
        rimraf = require('rimraf'),
        utils = require('../../js/lib/util'),
        jsonfile = require('jsonfile'),
        readjson = utils.promisify(jsonfile, 'readFile'),
        writejson = utils.promisify(jsonfile, 'writeFile');

    function migrateAll (list) {
        let p = Promise.resolve(false);
        let results = [];
        _.forEach(list, function (paths) {
            p = p.then(function () {
                return migrate(paths)
                    .catch(function (err) {
                        console.log(err);
                        return false;
                    }).then(function (result) {
                        results.push(result);
                    });
            })
        });

        return p.then(function () {
            return _.compact(results);
        })
    }

    /**
     * Performs the nessesary migrations on a target translation.
     * Migrations should always pass through in order to collect all needed updates
     * without having to always update past migrations.
     * @param paths {object}
     * @returns {Promise.<boolean>} true if migration was successful
     */
    function migrate (paths) {

        var readManifest = function (paths) {
            return readjson(paths.manifest).then(function (manifest) {
                manifest.package_version = manifest.package_version || 2;
                return {manifest: manifest, paths: paths};
            })
        };

        var migrateV2 = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            if (manifest.package_version <= 2) {
                // finished frames
                manifest.finished_frames = [];
                _.forEach(manifest.frames, function(finished, frame) {
                    if(finished) {
                        manifest.finished_frames.push(frame);
                    }
                });
                delete manifest.frames;

                // finished chapter titles/references
                manifest.finished_titles = [];
                manifest.finished_references = [];
                _.forEach(manifest.chapters, function(state, chapter) {
                    if(state.finished_title) {
                        manifest.finished_titles.push(chapter);
                    }
                    if(state.finished_reference) {
                        manifest.finished_references.push(chapter);
                    }
                });
                delete manifest.chapters;

                // project id
                manifest.project_id = manifest.slug;
                delete manifest.slug;

                // target language
                manifest.target_language.id = manifest.target_language.slug;
                delete manifest.target_language.slug;

                // add placeholders
                manifest.package_version = 3;
                if(!manifest.hasOwnProperty('translators')) {
                    manifest.translators = [];
                }
                if(!manifest.hasOwnProperty('source_translations')) {
                    manifest.source_translations = {};
                }
            }

            return {manifest: manifest, paths: paths};
        };

        var migrateV3 = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            if (manifest.package_version <= 3) {
                // flatten translators to an array of names
                manifest.translators = _.unique(_.map(_.values(manifest.translators), function(obj) {
                    return typeof obj === 'string' ? obj : obj.name;
                }));
            }

            return {manifest: manifest, paths: paths};
        };

        var migrateV4 = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            if (manifest.package_version <= 4) {
                let dir = project.paths.projectDir;
                // translation type
                let typeId = _.get(manifest, 'project.type', 'text').toLowerCase();
                let typeNames = {
                    text: 'Text',
                    tn: 'Notes',
                    tq: 'Questions',
                    tw: 'Words',
                    ta: 'Academy'
                };
                if(_.has(manifest, 'project.type')) {
                    delete manifest.project.type;
                }
                manifest.type = {
                    id: typeId,
                    name: _.get(typeNames, typeId, '')
                };

                // update project
                // NOTE: this was actually in v3 but we missed it so we need to catch it here
                if(_.has(manifest, 'project_id')) {
                    manifest.project = {
                        id: manifest.project_id,
                        name: ""
                    };
                    delete manifest.project_id;
                }

                // update resource
                let resourceNames = {
                    ulb: 'Unlocked Literal Bible',
                    udb: 'Unlocked Dynamic Bible',
                    obs: 'Open Bible Stories',
                    reg: 'Regular'
                };
                if(_.has(manifest, 'resource_id')) {
                    let resourceId =_.get(manifest, 'resource_id', 'reg');
                    delete manifest.resource_id;
                    manifest.resource = {
                        id: resourceId,
                        name: _.get(resourceNames, resourceId, '')
                    };
                } else if(!_.has(manifest, 'resource')) {
                    // add missing resource
                    if(_.get(manifest, 'type.id') === 'text') {
                        let resourceId =_.get(manifest, 'project.id') === 'obs' ? 'obs' : 'reg';
                        manifest.resource = {
                            id: resourceId,
                            name: _.get(resourceNames, resourceId, '')
                        };
                    }
                }

                // update source translations
                manifest.source_translations = _.values(_.mapValues(manifest.source_translations, function(value, key) {
                    let parts = key.split('-');
                    if(parts.length > 2) {
                        let languageResourceId = key.substring(parts[0].length + 1, key.length);
                        let pieces = languageResourceId.split('-');
                        if(pieces.length > 0) {
                            let resourceId = pieces[pieces.length - 1];
                            value.resource_id = resourceId;
                            value.language_id = languageResourceId.substring(0, languageResourceId.length - resourceId.length - 1);
                        }
                    }
                    return value;
                }));

                // update parent draft
                if(_.has(manifest, 'parent_draft_resource_id')) {
                    manifest.parent_draft = {
                        resource_id: manifest.parent_draft_resource_id,
                        checking_entity: '',
                        checking_level: '',
                        comments: 'The parent draft is unknown',
                        contributors: '',
                        publish_date: '',
                        source_text: '',
                        source_text_version: '',
                        version: ''
                    };
                    delete manifest.parent_draft_resource_id;
                }

                // update finished chunks
                manifest.finished_chunks = _.get(manifest, 'finished_frames', []);
                delete manifest.finished_frames;

                // remove finished titles
                _.forEach(_.get(manifest, 'finished_titles'), function(value, index) {
                    let finishedChunks = _.get(manifest, 'finished_chunks', []);
                    finishedChunks.push(value + '-title');
                    manifest.finished_chunks = _.unique(finishedChunks);
                });
                delete manifest.finished_titles;

                // remove finished references
                _.forEach(_.get(manifest, 'finished_references'), function(value, index) {
                    let finishedChunks = _.get(manifest, 'finished_chunks', []);
                    finishedChunks.push(value + '-reference');
                    manifest.finished_chunks = _.unique(finishedChunks);
                });
                delete manifest.finished_references;

                // remove project components
                _.forEach(_.get(manifest, 'finished_project_components'), function(value, index) {
                    let finishedChunks = _.get(manifest, 'finished_chunks', []);
                    finishedChunks.push('00-'+value);
                    manifest.finished_chunks = _.unique(finishedChunks);
                });
                delete manifest.finished_project_components;

                // add format
                if(!_.has(manifest, 'format') || manifest.format === 'usx' || manifest.format === 'default') {
                    manifest.format = _.get(manifest, 'type.id', 'text') !== 'text' || _.get(manifest, 'project.id') === 'obs' ? 'markdown' : 'usfm';
                }

                // update package version
                manifest.package_version = 5;

                // update where project title is saved
                let oldProjectTitlePath = path.join(dir, 'title.txt');
                let projectTranslationDir = path.join(dir, '00');
                let newProjectTitlePath = path.join(projectTranslationDir, 'title.txt');
                if(fs.existsSync(oldProjectTitlePath)) {
                    try {
                        fs.mkdirSync(projectTranslationDir);
                    } catch (e) {
                        console.log(e);
                    }
                    let projectTitle = fs.readFileSync(oldProjectTitlePath).toString();
                    fs.writeFileSync(newProjectTitlePath, projectTitle);
                    fs.unlinkSync(oldProjectTitlePath);
                }
            }

            return {manifest: manifest, paths: paths};
        };

        var migrateV5 = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            if (manifest.package_version <= 5) {
                let oldname = paths.projectDir.substring(paths.projectDir.lastIndexOf(path.sep) + 1);
                if (manifest.project.id === "tw") {
                    manifest.project.id = "bible";
                    manifest.project.name = "translationWords";
                }
                if (manifest.project.id === "ta") {
                    manifest.project.id = "vol1";
                    manifest.project.name = "translationAcademy Vol 1";
                }
                let unique_id = manifest.target_language.id + "_" + manifest.project.id + "_" + manifest.type.id;
                if (manifest.resource.id !== "") {
                    unique_id += "_" + manifest.resource.id;
                }
                let oldpath = path.join(paths.parentDir, oldname);
                let newpath = path.join(paths.parentDir, unique_id);
                let localstorageitems = ["-chapter", "-index", "-selected", "-completion", "-source"];
                let backupDir = App.configurator.getUserPath('datalocation', 'automatic_backups');
                let oldbackup = path.join(backupDir, oldname);
                let readyfile = path.join(paths.projectDir, 'READY');
                let srcDir = path.resolve(path.join(__dirname, '../..'));
                let license = fs.readFileSync(path.join(srcDir, 'assets', 'LICENSE.md'));

                fs.writeFileSync(paths.license, license);
                rimraf.sync(readyfile);
                rimraf.sync(oldbackup);

                for (var i = 0; i < localstorageitems.length; i++) {
                    App.configurator.setValue(unique_id + localstorageitems[i], App.configurator.getValue(oldname + localstorageitems[i]));
                    App.configurator.unsetValue(oldname + localstorageitems[i]);
                }

                paths.projectDir = newpath;
                paths.manifest = path.join(newpath, 'manifest.json');
                paths.license = path.join(newpath, 'LICENSE.md');

                // update package version
                manifest.package_version = 6;

                return utils.mkdirp(newpath).then(function () {
                    return utils.move(oldpath, newpath, {clobber: true}).then(function () {
                        return {manifest: manifest, paths: paths};
                    });
                });
            }

            return {manifest: manifest, paths: paths};
        };

        var migrateV6 = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            if (manifest.package_version <= 6) {
                //add code here to migrate to v7
            }

            return {manifest: manifest, paths: paths};
        };

        var checkVersion = function (project) {
            if (project.manifest.package_version !== 6) {
                throw new Error("Failed to migrate project");
            }
            return project;
        };

        var saveManifest = function (project) {
            let manifest = project.manifest;
            let paths = project.paths;

            manifest.generator.name = 'ts-desktop';
            // TODO: update build number

            return writejson(paths.manifest, manifest, {spaces:2}).then(utils.ret({manifest: manifest, paths: paths}));
        };

        return readManifest(paths)
            .then(migrateV2)
            .then(migrateV3)
            .then(migrateV4)
            .then(migrateV5)
            .then(migrateV6)
            .then(checkVersion)
            .then(saveManifest)

    }

    exports.migrate = migrate;
    exports.migrateAll = migrateAll;
}());
