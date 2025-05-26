const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const yauzl = require('yauzl');
const PhotoOrganizer = require('./organizer');

class BatchProcessor {
  constructor(options) {
    this.sourceDirectory = path.resolve(options.sourceDirectory);
    this.targetDirectory = path.resolve(options.targetDirectory);
    this.dryRun = options.dryRun || false;
    this.verbose = options.verbose || false;
    this.progressive = options.progressive || false;
        this.tempDir = path.join(this.sourceDirectory, '.temp-extraction');

    // Global statistics
    this.globalStats = {
      zipFilesProcessed: 0,
      totalImagesProcessed: 0,
      totalVideosProcessed: 0,
      totalFilesMoved: 0,
      totalFilesRenamed: 0,
      totalJsonFilesRemoved: 0,
      totalLiveVideosRemoved: 0,
      totalEmptyDirsRemoved: 0,
      totalErrors: 0,
      filesCopiedToTarget: 0
    };
  }

  async processBatch() {
    // Validate directories
    if (!await fs.pathExists(this.sourceDirectory)) {
      throw new Error(`Source directory does not exist: ${this.sourceDirectory}`);
    }

    // Ensure target directory exists
    await fs.ensureDir(this.targetDirectory);

    // Find all zip files
    const zipFiles = await this.findZipFiles();

    if (zipFiles.length === 0) {
      console.log(chalk.yellow('No zip files found in source directory'));
      return;
    }

    console.log(chalk.green(`Found ${zipFiles.length} zip files to process\n`));

    // Process each zip file
    for (let i = 0; i < zipFiles.length; i++) {
      const zipFile = zipFiles[i];
      const zipName = path.basename(zipFile);

      console.log(chalk.blue(`[${i + 1}/${zipFiles.length}] Processing: ${zipName}`));

      try {
        await this.processZipFile(zipFile);
        this.globalStats.zipFilesProcessed++;

        if (this.progressive && i < zipFiles.length - 1) {
          console.log(chalk.yellow('\nProgressive mode: Press Enter/Space to continue, Q to quit...'));
          try {
            await this.waitForEnter();
          } catch (error) {
            if (error.message === 'USER_QUIT') {
              break; // Exit the processing loop gracefully
            }
            throw error; // Re-throw other errors
          }
        }

            } catch (error) {
        this.globalStats.totalErrors++;
        console.error(chalk.red(`❌ Error processing ${zipName}: ${error.message}`));
        if (this.verbose) {
          console.error(error.stack);
        }

        if (this.progressive) {
          console.log(chalk.red('\nProgressive mode: Stopping due to error. Fix the issue and restart.'));
          break;
        }
      }

      console.log(''); // Empty line for readability
    }

    // Show final statistics
    this.showGlobalStatistics();
  }

  async findZipFiles() {
    const files = await fs.readdir(this.sourceDirectory);
    return files
      .filter(file => path.extname(file).toLowerCase() === '.zip')
      .map(file => path.join(this.sourceDirectory, file))
      .sort();
  }

  async processZipFile(zipFilePath) {
    const zipName = path.basename(zipFilePath);

    if (this.dryRun) {
      // In dry run mode, just simulate the process without extraction
      console.log(chalk.green(`✅ ${zipName}: Would extract, organize, and copy files to target`));
      this.globalStats.zipFilesProcessed++;
      return;
    }

    // Step 1: Extract zip file
    const extractPath = await this.extractZip(zipFilePath);

    try {
      // Step 2: Find Google Photos folder
      const googlePhotosPath = await this.findGooglePhotosFolder(extractPath);

      if (!googlePhotosPath) {
        throw new Error('Google Photos folder not found in extracted content');
      }

      // Step 3: Organize photos in extracted folder
      const organizer = new PhotoOrganizer({
        baseDirectory: googlePhotosPath,
        dryRun: this.dryRun,
        verbose: false, // Suppress verbose output for batch processing
        debug: false
      });

      await organizer.organize();

      // Accumulate stats
      this.accumulateStats(organizer.stats);

      // Step 4: Copy organized files to target directory
      const copiedFiles = await this.copyOrganizedFiles(googlePhotosPath);
      this.globalStats.filesCopiedToTarget += copiedFiles;

      console.log(chalk.green(`✅ ${zipName}: Organized ${organizer.stats.imagesProcessed + organizer.stats.videosProcessed} files, copied ${copiedFiles} to target`));

      // Step 5: Cleanup
      await fs.remove(zipFilePath); // Remove original zip
      await fs.remove(extractPath); // Remove extracted content

    } catch (error) {
      // Cleanup on error
      if (await fs.pathExists(extractPath)) {
        await fs.remove(extractPath);
      }
      throw error;
    }
  }

  async extractZip(zipFilePath) {
    const zipName = path.basename(zipFilePath, '.zip');
    const extractPath = path.join(this.tempDir, zipName);

    await fs.ensureDir(extractPath);
    await this.extractZipToDirectory(zipFilePath, extractPath);

    return extractPath;
  }

  async extractZipToDirectory(zipFilePath, extractPath) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            // Directory entry
            zipfile.readEntry();
          } else {
            // File entry
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);

              const filePath = path.join(extractPath, entry.fileName);
              fs.ensureDir(path.dirname(filePath))
                .then(() => {
                  const writeStream = fs.createWriteStream(filePath);
                  readStream.pipe(writeStream);
                  writeStream.on('close', () => {
                    zipfile.readEntry();
                  });
                  writeStream.on('error', reject);
                })
                .catch(reject);
            });
          }
        });

        zipfile.on('end', resolve);
        zipfile.on('error', reject);
      });
    });
  }

    async findGooglePhotosFolder(extractPath) {
    // Strategy 1: Direct Takeout/Google Photos pattern
    const directPath = await this.checkDirectTakeoutPattern(extractPath);
    if (directPath) return directPath;

    // Strategy 2: Single root folder (common with zip files)
    const singleRootPath = await this.checkSingleRootFolder(extractPath);
    if (singleRootPath) return singleRootPath;

    // Strategy 3: Recursive search as fallback
    return await this.searchForGooglePhotosFolder(extractPath);
  }

  async checkDirectTakeoutPattern(extractPath) {
    const takeoutPath = path.join(extractPath, 'Takeout');
    if (await fs.pathExists(takeoutPath)) {
      return await this.findGooglePhotosInTakeout(takeoutPath);
    }
    return null;
  }

  async checkSingleRootFolder(extractPath) {
    try {
      const contents = await fs.readdir(extractPath);
      if (contents.length === 1) {
        const singleItem = contents[0];
        const singleItemPath = path.join(extractPath, singleItem);
        const stat = await fs.stat(singleItemPath);

        if (stat.isDirectory()) {
          if (singleItem === 'Takeout') {
            return await this.findGooglePhotosInTakeout(singleItemPath);
          } else {
            // Check for nested Takeout folder
            const nestedTakeoutPath = path.join(singleItemPath, 'Takeout');
            if (await fs.pathExists(nestedTakeoutPath)) {
              return await this.findGooglePhotosInTakeout(nestedTakeoutPath);
            }
          }
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.log(chalk.gray(`Error checking single root folder: ${err.message}`));
      }
    }
    return null;
  }

  async findGooglePhotosInTakeout(takeoutPath) {
    try {
      // Try exact match first
      const exactPath = path.join(takeoutPath, 'Google Photos');
      if (await fs.pathExists(exactPath)) {
        return exactPath;
      }

      // Search for variations
      const contents = await fs.readdir(takeoutPath);
      for (const item of contents) {
        const itemPath = path.join(takeoutPath, item);
        const stat = await fs.stat(itemPath);

        if (stat.isDirectory() && this.isGooglePhotosFolder(item)) {
          return itemPath;
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.log(chalk.gray(`Error searching in Takeout folder: ${err.message}`));
      }
    }
    return null;
  }

  isGooglePhotosFolder(folderName) {
    const lower = folderName.toLowerCase();
    return lower.includes('google') && lower.includes('photos');
  }

  async searchForGooglePhotosFolder(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);

        if (entry.name === 'Google Photos') {
          return fullPath;
        }

        // Recursively search subdirectories
        const found = await this.searchForGooglePhotosFolder(fullPath);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  async copyOrganizedFiles(sourcePath) {
    let copiedCount = 0;

    // Find all year directories in the organized source
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    const yearDirs = entries.filter(entry =>
      entry.isDirectory() && /^\d{4}$/.test(entry.name)
    );

    for (const yearDir of yearDirs) {
      const sourceYearPath = path.join(sourcePath, yearDir.name);
      const targetYearPath = path.join(this.targetDirectory, yearDir.name);

      copiedCount += await this.copyYearDirectory(sourceYearPath, targetYearPath);
    }

    return copiedCount;
  }

  async copyYearDirectory(sourceYearPath, targetYearPath) {
    let copiedCount = 0;

    await fs.ensureDir(targetYearPath);

    const monthEntries = await fs.readdir(sourceYearPath, { withFileTypes: true });
    const monthDirs = monthEntries.filter(entry =>
      entry.isDirectory() && /^\d{2}$/.test(entry.name)
    );

    for (const monthDir of monthDirs) {
      const sourceMonthPath = path.join(sourceYearPath, monthDir.name);
      const targetMonthPath = path.join(targetYearPath, monthDir.name);

      copiedCount += await this.copyMonthDirectory(sourceMonthPath, targetMonthPath);
    }

    return copiedCount;
  }

  async copyMonthDirectory(sourceMonthPath, targetMonthPath) {
    let copiedCount = 0;

    await fs.ensureDir(targetMonthPath);

    const files = await fs.readdir(sourceMonthPath);

    for (const file of files) {
      const sourceFilePath = path.join(sourceMonthPath, file);
      const targetFilePath = path.join(targetMonthPath, file);

      // Only copy if file doesn't exist in target (incremental)
      if (!await fs.pathExists(targetFilePath)) {
        await fs.copy(sourceFilePath, targetFilePath);
        copiedCount++;
      }
    }

    return copiedCount;
  }

  accumulateStats(stats) {
    this.globalStats.totalImagesProcessed += stats.imagesProcessed;
    this.globalStats.totalVideosProcessed += stats.videosProcessed;
    this.globalStats.totalFilesMoved += stats.filesMoved;
    this.globalStats.totalFilesRenamed += stats.filesRenamed;
    this.globalStats.totalJsonFilesRemoved += stats.jsonFilesRemoved;
    this.globalStats.totalLiveVideosRemoved += stats.liveVideosRemoved;
    this.globalStats.totalEmptyDirsRemoved += stats.emptyDirsRemoved;
    this.globalStats.totalErrors += stats.errors;
  }

  showGlobalStatistics() {
    console.log('\n' + chalk.blue.bold('📊 Batch Processing Summary:'));

    if (this.dryRun) {
      console.log(chalk.yellow(`📦 Zip files that would be processed: ${this.globalStats.zipFilesProcessed}`));
      console.log(chalk.yellow('\n🔍 This was a dry run - no files were actually modified'));
    } else {
      console.log(chalk.green(`📦 Zip files processed: ${this.globalStats.zipFilesProcessed}`));
      console.log(chalk.green(`📸 Total images processed: ${this.globalStats.totalImagesProcessed}`));
      console.log(chalk.green(`🎬 Total videos processed: ${this.globalStats.totalVideosProcessed}`));
      console.log(chalk.green(`📁 Total files moved: ${this.globalStats.totalFilesMoved}`));
      console.log(chalk.green(`📝 Total files renamed: ${this.globalStats.totalFilesRenamed}`));
      console.log(chalk.green(`📋 Files copied to target: ${this.globalStats.filesCopiedToTarget}`));
      console.log(chalk.green(`🗑️  Total JSON files removed: ${this.globalStats.totalJsonFilesRemoved}`));
      console.log(chalk.green(`🎥 Total live videos removed: ${this.globalStats.totalLiveVideosRemoved}`));
      console.log(chalk.green(`📂 Total empty dirs removed: ${this.globalStats.totalEmptyDirsRemoved}`));
    }

    if (this.globalStats.totalErrors > 0) {
      console.log(chalk.red(`❌ Total errors: ${this.globalStats.totalErrors}`));
    }
  }

    async waitForEnter() {
    return new Promise((resolve, reject) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const cleanup = () => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
      };

      const onData = (key) => {
        // Handle different key inputs
        if (key === '\r' || key === '\n' || key === ' ') {
          // Continue to next file
          cleanup();
          console.log(''); // Add newline after keypress
          resolve();
        } else if (key === 'q' || key === 'Q') {
          // Quit gracefully
          cleanup();
          console.log(chalk.yellow('\nQuitting batch processing...'));
          reject(new Error('USER_QUIT'));
        } else if (key === '\u0003') {
          // Ctrl+C
          cleanup();
          console.log(chalk.red('\nInterrupted by user'));
          process.exit(0);
        }
      };

      process.stdin.on('data', onData);
    });
  }
}

module.exports = BatchProcessor;
