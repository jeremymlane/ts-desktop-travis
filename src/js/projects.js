'use strict';

var _ = require('lodash'),
    fs = require('fs'),
    path = require('path'),
    mkdirP = require('mkdirp'),
    rimraf = require('rimraf'),
    AdmZip = require('adm-zip'),
    archiver = require('archiver'),
    utils = require('../js/lib/util'),
    git = require('../js/git')(),
    tstudioMigrator = require('../js/migration/tstudioMigrator'),
    targetTranslationMigrator = require('../js/migration/targetTranslationMigrator'),
    wrap = utils.promisify,
    guard = utils.guard;

function zipper (r) {
    return r.length ? _.map(r[0].values, _.zipObject.bind(_, r[0].columns)) : [];
}

var map = guard('map'),
    indexBy = guard('indexBy'),
    flatten = guard('flatten'),
    compact = guard('compact');

/**
 *  var pm = ProjectsManager(query);
 *
 *  e.g. var pm = App.projectsManager;
 */

function ProjectsManager(query, configurator, srcDir) {

    // var puts = console.log.bind(console),  // Never used
    var write = wrap(fs, 'writeFile'),
        read = wrap(fs, 'readFile'),
        mkdirp = wrap(null, mkdirP),
        rm = wrap(null, rimraf),
        readdir = wrap(fs, 'readdir'),
        stat = wrap(fs, 'stat'),
        isDir = function (f) {
            return stat(f).then(function (s) {
                return s.isDirectory();
            });
        },
        isVisibleDir = function (f) {
            return isDir(f).then(function (isFolder) {
                var name = path.parse(f).name,
                    isHidden = /^\..*/.test(name);

                return (isFolder && !isHidden) ? f : false;
            });
        },
        filterDirs = function (dirs) {
            return Promise.all(_.map(dirs, isVisibleDir)).then(compact());
        },
        readdirs = function (dirs) {
            return Promise.all(_.map(dirs, function (d) {
                return readdir(d).then(map(function (f) {
                    return path.join(d, f);
                }));
            }));
        },
        toJSON = _.partialRight(JSON.stringify, null, '\t'),
        fromJSON = JSON.parse.bind(JSON),
        // NOTE: Old auto-backup implementation
        // backupTimer,
        config = (function (prefix) {
            var isUW = _.partial(_.startsWith, _, prefix, 0),
                isChunk = function (filename) {
                    return _.endsWith(filename, '.txt');
                };

            return {
                filterProjects: _.partial(_.filter, _, isUW),

                filterChapters: filterDirs,

                filterChunks: _.partial(_.filter, _, isChunk),

                get targetDir () {
                    return configurator.getValue('targetTranslationsDir');
                },


                makeProjectPaths: function (meta) {
                    var filename;

                    if (meta.package_version < 6) {
                        filename = prefix + meta.fullname;
                    } else {
                        filename = meta.unique_id;
                    }

                    return this.makeProjectPathsForProject(filename);
                },

                makeProjectPathsForProject: function (project) {
                    var targetDir = this.targetDir,
                        projectDir = path.join(targetDir, project);

                    return {
                        parentDir: targetDir,
                        projectDir: projectDir,
                        manifest: path.join(projectDir, 'manifest.json'),
                        license: path.join(projectDir, 'LICENSE.md')
                    };

                }
            };
        })('uw-');

    return {

        /**
         *  var l = pm.targetLanguages,
         *      africanLangs = _.filter(l, 'region', 'Africa'),
         *      europeanLangs = _.filter(l, 'region', 'Europe'),
         *      en = _.find(l, 'lc', 'en');
         */

        get targetLanguages () {
            var r = query("select slug 'id', name, direction from target_language order by slug");
            return zipper(r);
        },

        /**
         *  var projects = pm.getProjects('en');
         *
         *  Defaults to English ('en'). This is equivalent:
         *    var projects = pm.getProjects();
         *
         *  var grouped = _.groupBy(projects, 'category'),
         *      partitioned = _.partition(projects, 'category');
         */

        getProjects: function (lang) {
            var r = query([
                    "select p.id, p.slug, sl.project_name 'name', sl.project_description 'desc', c.category_name 'category' from project p",
                    "join source_language sl on sl.project_id=p.id",
                    "left join source_language__category c on c.source_language_id=sl.id",
                    "where sl.slug='" + (lang || 'en') + "'",
                    "order by p.sort"
                ].join(' '));
            return zipper(r);
        },

        getProjectName: function (id) {
            var r = query([
                "select sl.project_name 'name' from project p",
                "join source_language sl on sl.project_id=p.id",
                "where sl.slug='en' and p.slug='" + id + "'"
            ].join(' '));
            return zipper(r);
        },

        /**
         *  var sources = pm.sources,
         *      englishSources = _.filter(sources, 'lc', 'en'),
         *      genesisSources = _.filter(sources, 'project', 'gen'),
         *      enGenSources = _.filter(sources, {'lc': 'en', 'project': 'gen'});
         */

        get sources () {
            var r = query([
                    "select r.id, r.slug 'resource_id', r.name 'resource_name', l.name 'language_name', l.slug 'language_id', p.slug 'project_id', r.checking_level, r.version, r.modified_at 'date_modified' from resource r",
                    "join source_language l on l.id=r.source_language_id",
                    "join project p on p.id=l.project_id",
                    "order by r.name"
                ].join(' '));
            return zipper(r);
        },

        getSourceDetails: function (project_id, language_id, resource_id) {
            var r = query([
                "select r.id, r.name 'resource_name', l.name 'language_name', p.slug 'project_id' from resource r",
                "join source_language l on l.id=r.source_language_id",
                "join project p on p.id=l.project_id",
                "where p.slug='" + project_id + "' and l.slug='" + language_id + "' and r.slug='" + resource_id + "'"
            ].join(' '));
            return zipper(r);
        },

        /**
         *  var frames = pm.getSourceFrames(source),
         *      groupedByChapter = _(frames).groupBy('chapter').values().sortBy('0.chapter').value();
         *
         *  var getFrames = pm.getSourceFrames.bind(null, source),
         *      s1 = getFrames('udb'),
         *      s2 = getFrames('ulb');
         */

        getSourceFrames: function (source) {
            var s = typeof source === 'object' ? source.id : source,
                r = query([
                    "select f.id, f.slug 'verse', f.body 'chunk', c.slug 'chapter', c.title, c.reference, f.format from frame f",
                    "join chapter c on c.id=f.chapter_id",
                    "join resource r on r.id=c.resource_id",
                    "join source_language sl on sl.id=r.source_language_id",
                    "join project p on p.id=sl.project_id where r.id='" + s + "'",
                    "order by c.sort, f.sort"
                ].join(' '));

            return zipper(r);
        },

        checkProject: function (project) {
            var allsources = this.sources;
            var mysources = _.filter(allsources, 'project_id', project);
            var combined = {};
            var sources = [];
            for (var i = 0; i < mysources.length; i++) {
                var source = mysources[i].resource_id;
                var frames = this.getSourceFrames(mysources[i]);
                console.log("resource:", source, "chunks:", frames.length);
                combined[source] = frames;
                sources.push(source);
            }
            var match = true;
            var j = 0;
            while (match && j < combined[sources[0]].length) {
                var testref = combined[sources[0]][j].chapter + combined[sources[0]][j].verse;
                for (var k = 1; k < sources.length; k++) {
                    var checkref = combined[sources[k]][j].chapter + combined[sources[k]][j].verse;
                    if (testref !== checkref) {
                        match = false;
                        var firsterror = testref;
                    }
                }
                j++;
            }
            if (match) {
                console.log("                             ALL CHUNKS LINE UP!");
            } else {
                console.log("                             First error occurs at " + firsterror);
            }
            console.log("Data:");
            console.log(combined);
        },

        checkAllProjects: function () {
            var allsources = this.sources;
            var ulbsources = _.filter(allsources, 'resource_id', 'ulb');
            for (var i = 0; i < ulbsources.length; i++) {
                console.log("Project Results              Name: " + ulbsources[i].project_id);
                this.checkProject(ulbsources[i].project_id);
                console.log("---------------------------------------------------------------");
            }
        },

        getFrameUdb: function (source, chapterid, verseid) {
            var sources = this.sources;
            var udbsource = _.filter(sources, {'language_id': source.language_id, 'project_id': source.project_id, 'checking_level': 3, 'resource_id': 'udb'});
            var s = udbsource[0].id,
                r = query([
                    "select f.id, f.slug 'verse', f.body 'chunk', c.slug 'chapter', c.title, c.reference, f.format from frame f",
                    "join chapter c on c.id=f.chapter_id",
                    "join resource r on r.id=c.resource_id",
                    "join source_language sl on sl.id=r.source_language_id",
                    "join project p on p.id=sl.project_id where r.id='" + s + "' and c.slug='" + chapterid + "' and f.slug='" + verseid + "'"
                ].join(' '));

            return zipper(r);
        },

        getFrameNotes: function (frameid) {

                var r = query([
                    "select title, body from translation_note",
                    "where frame_id='" + frameid + "'"
                ].join(' '));

            return zipper(r);
        },

        getFrameWords: function (frameid) {

            var r = query([
                "select w.id, w.slug, w.term 'title', w.definition 'body', w.definition_title 'deftitle' from translation_word w",
                "join frame__translation_word f on w.id=f.translation_word_id",
                "where f.frame_id='" + frameid + "'"
            ].join(' '));

            return zipper(r);
        },

        getRelatedWords: function (wordid) {

            var r = query([
                "select w.id, w.term 'title', w.definition 'body', w.definition_title 'deftitle' from translation_word w",
                "join translation_word_related r on w.slug=r.slug",
                "where r.translation_word_id='" + wordid + "'"
            ].join(' '));

            return zipper(r);
        },

        getAllWords: function (source) {
            var s = typeof source === 'object' ? source.id : source;
            var r = query([
                "select w.id, w.slug, w.term 'title', w.definition 'body', w.definition_title 'deftitle' from translation_word w",
                "join resource__translation_word r on r.translation_word_id=w.id",
                "where r.resource_id='" + s + "'",
                "order by lower(w.term)"
            ].join(' '));

            return zipper(r);
        },

        getWordExamples: function (wordid) {

            var r = query([
                "select cast(e.frame_slug as int) 'frame', cast(e.chapter_slug as int) 'chapter', e.body from translation_word_example e",
                "where e.translation_word_id='" + wordid + "'"
            ].join(' '));

            return zipper(r);
        },

        getFrameQuestions: function (frameid) {

            var r = query([
                "select q.question 'title', q.answer 'body' from checking_question q",
                "join frame__checking_question f on q.id=f.checking_question_id",
                "where f.frame_id='" + frameid + "'"
            ].join(' '));

            return zipper(r);
        },

        getTa: function (volume) {
            var r = query([
                "select t.id, t.slug, t.title, t.text 'body', t.reference from translation_academy_article t",
                "join translation_academy_manual m on m.id=t.translation_academy_manual_id",
                "join translation_academy_volume v on v.id=m.translation_academy_volume_id",
                "where v.slug like '" + volume + "'"
            ].join(' '));

            return zipper(r);
        },

        getVolumes: function () {
            var r = query([
                "select v.slug, v.title from translation_academy_volume v"
            ].join(' '));

            return zipper(r);
        },

        getPaths: function(meta) {
            return config.makeProjectPaths(meta);
        },

        backupTranslation: function (meta, filePath) {
            let paths = this.getPaths(meta),
                name = meta.unique_id;

            return new Promise(function(resolve, reject) {
                let output = fs.createWriteStream(filePath),
                    archive = archiver.create('zip'),
                    manifest = {
                        generator: {
                            name: 'ts-desktop',
                            build: ''
                        },
                        package_version: 2,
                        timestamp: new Date().getTime(),
                        target_translations: [{path: name, id: name, commit_hash: '', direction: "ltr"}]
                    };
                archive.pipe(output);
                archive.directory(paths.projectDir, name + "/");
                archive.append(toJSON(manifest), {name: 'manifest.json'});
                archive.finalize();
                resolve(filePath);
            });
        },

        /*
         * Moves (using utils function) .tstudio files from the old to the new path
         * @param oldPath: source backup directory
         * @param newPath: target backup directory
         */
        migrateBackup: function(oldPath, newPath) {
            utils.move(path.join(oldPath, 'automatic_backups'), path.join(newPath, 'automatic_backups'), {clobber: true});
            utils.move(path.join(oldPath, 'backups'), path.join(newPath, 'backups'), {clobber: true});
        },

        /*
         * Store projects in automatic backup folder if there's any change
         * @param list: projectlist property
         */
        backupProjects: function(list) {
            let _this = this,
                backupDir = configurator.getUserPath('datalocation', 'automatic_backups');

            /*
             * NOTE: We are removing *after* we backup so that a backup is already there.
             *          Example scenario: App attempts to auto backup, deletes all the
             *          generated auto backups, tries to backup, then crashes. In this
             *          instance, the user is left without backups. So, instead, we
             *          clear out any old files only after we are certain that there
             *          is a new backup.
             */

            let removeOtherFiles = function(backupName) {
                let paths = path.parse(backupName),
                    dir = paths.dir,
                    hash = paths.base.split('.')[0];

                // N.B. Double check that we're in the backups folder before doing any remove/delete
                return dir.startsWith(backupDir) ? rm(dir + '/!(' + hash + ')*') : false;
            };

            let promises = _.map(list, function(meta) {
                let sourceDir = _this.getPaths(meta).projectDir,
                    projectFolder = path.basename(sourceDir),
                    targetDir = path.join(backupDir, projectFolder),
                    doBackup = _this.backupTranslation.bind(_this, meta);

                return mkdirp(targetDir)
                    .then(function () {
                        return git.getHash(sourceDir);
                    })
                    .then(function(hash) {
                        let fileName = hash + '.backup.tstudio';
                        return path.join(targetDir, fileName);
                    })
                    .then(doBackup)
                    .then(removeOtherFiles);
            });

            return Promise.all(promises);
        },

        /**
         *
         * @param translation an array of frames
         * @param meta the target translation manifest and other info
         * @param filePath the path where the export will be saved
         * @param mediaServer is the location of the media files
         * @returns {Promise.<boolean>}
         */
        exportTranslation: function (translation, meta, filePath, mediaServer) {

            var isTranslation = this.isTranslation(meta);

            return new Promise(function(resolve, reject) {
                if (isTranslation) {

                    if (meta.format === 'markdown') {

                        let chapterContent = '',
                            currentChapter = -1,
                            zip = archiver.create('zip'),
                            output = fs.createWriteStream(filePath),
                            numFinishedFrames = 0;
                        zip.pipe(output);
                        for(let frame of translation) {

                            // close chapter chapter
                            if(frame.meta.chapter !== currentChapter) {
                                if(chapterContent !== '' && numFinishedFrames > 0) {
                                    // TODO: we need to get the chapter reference and insert it here
                                    chapterContent += '////\n';
                                    //console.log('chapter ' + currentChapter, chapterContent);
                                    zip.append(new Buffer(chapterContent), {name: currentChapter + '.txt'});
                                }
                                currentChapter = frame.meta.chapter;
                                chapterContent = '';
                                numFinishedFrames = 0;
                            }

                            if(frame.transcontent !== '') {
                                numFinishedFrames ++;
                            }

                            // build chapter header
                            if(chapterContent === '') {
                                chapterContent += '//\n';
                                chapterContent += meta.target_language.name + '\n';
                                chapterContent += '//\n\n';

                                chapterContent += '//\n';
                                chapterContent += meta.project.name + '\n';
                                chapterContent += '//\n\n';

                                chapterContent += '//\n';
                                chapterContent += frame.meta.title + '\n';
                                chapterContent += '//\n\n';
                            }

                            // add frame
                            chapterContent += '{{' + mediaServer + meta.project.id + '/jpg/1/en/360px/' + meta.project.id + '-' + meta.target_language.id + '-' + frame.meta.chapterid + '-' + frame.meta.frameid + '.jpg}}\n\n';
                            chapterContent += frame.transcontent + '\n\n';
                        }
                        if(chapterContent !== '' && numFinishedFrames > 0) {
                            // TODO: we need to get the chapter reference and insert it here
                            chapterContent += '////\n';
                            zip.append(new Buffer(chapterContent), {name: currentChapter + '.txt'});
                        }
                        zip.finalize();
                        resolve(true);
                    } else if (meta.format === 'usfm') {
                         let
                            currentChapter = 1,
                            numFinishedFrames = 0,
                            chapterContent = '';
                        for(let frame of translation) {
                            // build chapter header
                            if(chapterContent === '') {
                                //add in USFM header elements
                                chapterContent += '\n\\\id ' + meta.project.id.toUpperCase() + ' ' + meta.source_translations[0].resource_name + '\n';

                                chapterContent += '\\\ide ' + meta.format + '\n';

                                chapterContent += '\\\h ' + meta.project.name.toUpperCase() + '\n';

                                chapterContent += '\\' + 'toc1 ' + meta.project.name + '\n';

                                chapterContent += '\\' + 'toc2 ' + meta.project.name + '\n';

                                chapterContent += '\\' + 'toc3 ' + meta.project.id + '\n';

                                chapterContent += '\\\mt1 ' + meta.project.name.toUpperCase() + '\n';

                                chapterContent += '\\\c ' + frame.meta.chapter + '\n';
                            }
                            if(currentChapter !== frame.meta.chapter){
                                chapterContent += '\\\c ' + frame.meta.chapter + '\n';
                                currentChapter = frame.meta.chapter;
                            }
                            // add frame
                            if(frame.transcontent !== ''){
                            chapterContent += frame.transcontent + '\n';
                            }
                        }

                        fs.writeFile(filePath, new Buffer(chapterContent));
                        resolve(true);
                    } else {
                        reject("We do not support exporting this project format yet");
                    }
                } else {
                    // TODO: support exporting other target translation types if needed e.g. notes, words, questions
                    reject('We do not support exporting this project type yet');
                }
            });
        },

        /**
         * Imports a tstudio archive
         * @param filePath {String} the path to the archive
         * @returns {Promise}
         */
        restoreTargetTranslation: function(filePath) {
            let zip = new AdmZip(filePath),
                tmpDir = configurator.getValue('tempDir'),
                targetDir = configurator.getValue('targetTranslationsDir'),
                basename = path.basename(filePath, '.tstudio'),
                extractPath = path.join(tmpDir, basename);

            return tstudioMigrator.listTargetTranslations(filePath)
                .then(function(targetPaths) {
                    // NOTE: this will eventually be async
                    zip.extractAllTo(extractPath, true);
                    return targetPaths;
                })
                .then(function (targetPaths) {
                    return _.map(targetPaths, function (targetPath) {
                        var parentDir = extractPath;
                        var projectDir = path.join(extractPath, targetPath);
                        var manifest = path.join(projectDir, 'manifest.json');
                        var license = path.join(projectDir, 'LICENSE.md');
                        return {parentDir, projectDir, manifest, license};
                    });
                })
                .then(targetTranslationMigrator.migrateAll)
                .then(function (results) {
                    if (!results.length) {
                        throw new Error ("Could not restore this project");
                    }
                    return results;
                })
                .then(function (results) {
                    return _.map(results, function (result) {
                        return result.paths.projectDir.substring(result.paths.projectDir.lastIndexOf(path.sep) + 1);
                    });
                })
                .then(function (targetPaths) {
                    return _.map(targetPaths, function(p) {
                        let tmpPath = path.join(extractPath, p),
                            targetPath = path.join(targetDir, p);

                        return utils.move(tmpPath, targetPath, {clobber: true});
                    });
                })
                .then(function (list) {
                    return Promise.all(list);
                })
                .then(function () {
                    return rm(tmpDir);
                });
        },

        fileExists: function (filePath) {
            return stat(filePath).then(function (){
                return true;
            }).catch(function () {
                return false;
            });
        },

        isTranslation: function (meta) {
            return !meta.type.id || meta.type.id === 'text';
        },

        updateManifestToMeta: function (manifest) {
            var meta = manifest;
            try {
                if (manifest.project.name === "") {
                    meta.project.name = this.getProjectName(manifest.project.id)[0].name;
                }

                if (manifest.type.name === "" && manifest.type.id === "text") {
                    meta.type.name = "Text";
                }

                for (var j = 0; j < manifest.source_translations.length; j++) {
                    var details = this.getSourceDetails(manifest.project.id, manifest.source_translations[j].language_id, manifest.source_translations[j].resource_id)[0];
                    meta.source_translations[j].project_id = details.project_id;
                    meta.source_translations[j].id = details.id;
                    meta.source_translations[j].language_name = details.language_name;
                    meta.source_translations[j].resource_name = details.resource_name;
                }

                if (manifest.source_translations.length) {
                    meta.currentsource = 0;
                } else {
                    meta.currentsource = null;
                }

                if (manifest.type.id === "tw" || manifest.type.id === "ta") {
                    meta.project_type_class = "extant";
                } else if (manifest.type.id === "tn" || manifest.type.id === "tq") {
                    meta.project_type_class = "helps";
                } else {
                    meta.project_type_class = "standard";
                }

                meta.unique_id = manifest.target_language.id + "_" + manifest.project.id + "_" + manifest.type.id;
                if (manifest.resource.id !== "") {
                    meta.unique_id += "_" + manifest.resource.id;
                }

                var typeext = "";

                if (meta.project_type_class === "extant") {
                    typeext = "";
                } else if (manifest.type.id !== "text") {
                    typeext = "_" + manifest.type.id;
                } else if (manifest.resource.id === "udb") {
                    typeext = "_" + manifest.resource.id;
                }

                meta.fullname = manifest.project.id + typeext + "-" + manifest.target_language.id;

                var completion = App.configurator.getValue(meta.unique_id + "-completion");
                if (completion !== undefined && completion !== "") {
                    meta.completion = completion;
                } else {
                    meta.completion = 0;
                }
            } catch (err) {
                App.reporter.logError(err);
                return null;
            }
            return meta;
        },

        saveTargetTranslation: function (translation, meta, user) {
            var paths = this.getPaths(meta);
            var projectClass = meta.project_type_class;

            var makeComplexId = function (c) {
                return c.meta.chapterid + '-' + c.meta.frameid;
            };

            var prop = function (prop) {
                return function (v, k) {
                    return v[prop] ? k : false;
                };
            };

            var chunks = _.chain(translation)
                .indexBy(makeComplexId)
                .value();

            var finishedFrames = _.compact(_.map(chunks, prop('completed')));

            var sources = meta.source_translations.map(function (source) {
                    return {
                        language_id: source.language_id,
                        resource_id: source.resource_id,
                        checking_level: source.checking_level,
                        date_modified: source.date_modified,
                        version: source.version
                    };
                });

            var manifest = {
                package_version: meta.package_version,
                format: meta.format,
                generator: {
                    name: 'ts-desktop',
                    build: ''
                },
                target_language: meta.target_language,
                project: meta.project,
                type: meta.type,
                resource: meta.resource,
                source_translations: sources,
                parent_draft: meta.parent_draft,
                translators: meta.translators,
                finished_chunks: finishedFrames
            };

            var writeFile = function (name, data) {
                return function () {
                    return write(name, toJSON(data));
                };
            };

            var makeChapterDir = function (c) {
                return mkdirp(path.join(paths.projectDir, c.meta.chapterid));
            };

            var makeChapterDirs = function (data) {
                return function () {
                    return Promise.all(_.map(data, makeChapterDir));
                };
            };

            var cleanChapterDir = function (data, chapter) {
                var chapterpath = path.join(paths.projectDir, chapter);
                return readdir(chapterpath).then(function (dir) {
                    return !dir.length ? rm(chapterpath): true;
                });
            };

            var cleanChapterDirs = function () {
                return function () {
                    var data = _.groupBy(translation, function (chunks) {
                        return chunks.meta.chapterid;
                    });
                    return Promise.all(_.map(data, cleanChapterDir));
                };
            };

            var updateChunk = function (chunk) {
                var file = path.join(paths.projectDir, chunk.meta.chapterid, chunk.meta.frameid + '.txt');
                var hasContent = false;
                if (projectClass === "standard") {
                    hasContent = !!chunk.transcontent;
                }
                if (projectClass === "helps") {
                    hasContent = !!chunk.helpscontent.length;
                }
                if (projectClass === "extant" && (!!chunk.helpscontent[0].title || !!chunk.helpscontent[0].body)) {
                    hasContent = true;
                }
                return hasContent ? write(file, projectClass === "standard" ? chunk.transcontent : toJSON(chunk.helpscontent)) : rm(file);
            };

            var updateChunks = function (data) {
                return function () {
                    return Promise.all(_.map(data, updateChunk));
                };
            };

            var setLicense = function () {
                return read(path.join(srcDir, 'assets', 'LICENSE.md'))
                    .then(function(data) {
                        return write(paths.license, data);
                    });
            };

            return mkdirp(paths.projectDir)
                .then(setLicense())
                .then(writeFile(paths.manifest, manifest))
                .then(makeChapterDirs(chunks))
                .then(updateChunks(chunks))
                .then(cleanChapterDirs())
                .then(function () {
                    return git.init(paths.projectDir);
                })
                .then(function () {
                    return git.stage(user, paths.projectDir);
                });
        },

        loadProjectsList: function () {
            return readdir(config.targetDir);
        },

        loadTargetTranslationsList: function () {
            var makePaths = config.makeProjectPathsForProject.bind(config);

            return this.loadProjectsList()
                .then(map(makePaths))
                .then(map('manifest'))
                .then(function (list) {
                    return _.filter(list, function (path) {
                        try {
                            var test = fs.statSync(path);
                        } catch (e) {
                            test = false;
                        }
                        return test;
                    })
                })
                .then(map(read))
                .then(Promise.all.bind(Promise))
                .then(map(fromJSON))
        },

        migrateTargetTranslationsList: function () {
            var makePaths = config.makeProjectPathsForProject.bind(config);

            return this.loadProjectsList()
                .then(map(makePaths))
                .then(targetTranslationMigrator.migrateAll)
        },

        loadFinishedFramesList: function (meta) {
            var paths = config.makeProjectPaths(meta);

            return read(paths.manifest).then(function (manifest) {
                var finishedFrames = fromJSON(manifest).finished_chunks;
                return _.indexBy(finishedFrames);
            });
        },

        loadTargetTranslation: function (meta) {
            var paths = this.getPaths(meta);
            var isTranslation = this.isTranslation(meta);

            // NOTE: Old auto-backup implementation
            // this.startAutoBackup(meta);

            // read manifest, get object with finished frames

            // return an object with keys that are the complexid

            var parseChunkName = function (f) {
                var p = path.parse(f),
                    ch = p.dir.split(path.sep).slice(-1);

                return ch + '-' + p.name;
            };

            var readChunk = function (f) {
                return read(f).then(function (c) {
                    var parsed = {
                        name: parseChunkName(f)
                    };

                    if (isTranslation) {
                        parsed['transcontent'] = c.toString();
                    } else {
                        parsed['helpscontent'] = JSON.parse(c);
                    }

                    return parsed;
                });
            };

            var markFinished = function (chunks) {
                return function (finished) {
                    return _.mapValues(chunks, function (c, name) {
                        var mapped = {
                            completed: !!finished[name]
                        },
                        key = isTranslation ? 'transcontent' : 'helpscontent';

                        mapped[key] = c[key];

                        return mapped;
                    });
                };
            };

            var makeFullPath = function (parent) {
                return function (f) {
                    return path.join(parent, f);
                };
            };

            return readdir(paths.projectDir)
                .then(map(makeFullPath(paths.projectDir)))
                .then(config.filterChapters)
                .then(flatten())
                .then(readdirs)
                .then(flatten())
                .then(map(readChunk))
                .then(Promise.all.bind(Promise))
                .then(indexBy('name'))
                .then(function (chunks) {
                    return this.loadFinishedFramesList(meta).then(markFinished(chunks));
                }.bind(this));
        },

        deleteTargetTranslation: function (meta) {
            var paths = this.getPaths(meta);

            return rm(paths.projectDir);
        }
    };
}

module.exports.ProjectsManager = ProjectsManager;
