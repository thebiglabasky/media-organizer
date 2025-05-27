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
    this.useDetailedTimestamp = options.useDetailedTimestamp || false;
    this.duplicateSuffix = options.duplicateSuffix || null;
    this.tempDir = path.join(this.sourceDirectory, '.temp-extraction');

    // Use shared image extensions from PhotoOrganizer
    const tempOrganizer = new PhotoOrganizer({ baseDirectory: '.' });
    this.imageExtensions = tempOrganizer.imageExtensions;

    // Cache file for target hash database
    this.hashCacheFile = path.join(this.targetDirectory, '.photo-organizer-cache.json');

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
      filesCopiedToTarget: 0,
      filesRenamedForConflicts: 0,
      duplicatesSkipped: 0,
      totalDuplicatesRemoved: 0
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

      // Step 3: Handle duplicates if suffix is specified, then organize photos
      const organizer = new PhotoOrganizer({
        baseDirectory: googlePhotosPath,
        dryRun: this.dryRun,
        verbose: false, // Suppress verbose output for batch processing
        debug: false,
        useDetailedTimestamp: this.useDetailedTimestamp,
        duplicateSuffix: this.duplicateSuffix
      });

      // Handle duplicates first if suffix is specified, then organize
      if (this.duplicateSuffix) {
        console.log(chalk.cyan(`🔄 Handling duplicates with suffix "${this.duplicateSuffix}" in ${path.basename(googlePhotosPath)}`));

        // Use the same pattern as rename-by-exif: handle duplicates first, then organize remaining files
        await this.handleDuplicatesAndOrganize(organizer);
      } else {
        // No duplicate handling, just organize normally
        await organizer.organize();
      }

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

    // Step 1: Build hash database of all files in source
    const scanSpinner = ora('Scanning source files...').start();
    const sourceFiles = await this.scanAllFiles(sourcePath);
    scanSpinner.succeed(`Found ${sourceFiles.length} source files to process`);

    const sourceHashes = await this.buildHashDatabase(sourceFiles);

    // Step 2: Build hash database of existing target files
    const targetHashes = await this.buildTargetHashDatabase();

    // Step 3: Copy files based on content, not filename
    const copySpinner = ora(`Copying unique files to target...`).start();
    let processed = 0;

    for (const sourceFile of sourceFiles) {
      processed++;

      // Update progress every 10 files
      if (processed % 10 === 0 || processed === sourceFiles.length) {
        const progress = (processed / sourceFiles.length * 100).toFixed(1);
        copySpinner.text = `Copying files: ${processed}/${sourceFiles.length} (${progress}%) - ${path.basename(sourceFile)}`;
      }

      const sourceHash = sourceHashes.get(sourceFile);
      if (!sourceHash) continue; // Skip files that couldn't be hashed

      if (targetHashes.has(sourceHash)) {
        // Duplicate exists in target, skip
        this.globalStats.duplicatesSkipped++;
        if (this.verbose) {
          console.log(chalk.gray(`  Skipped duplicate: ${path.basename(sourceFile)} (content already exists)`));
        }
        continue;
      }

      // File is unique, copy it
      const relativePath = path.relative(sourcePath, sourceFile);
      const targetPath = path.join(this.targetDirectory, relativePath);

      await fs.ensureDir(path.dirname(targetPath));

      // Check if target filename exists and find unique name if needed
      const finalTargetPath = await this.findUniqueFilename(targetPath);
      await fs.copy(sourceFile, finalTargetPath);

      // Add to target hash database
      targetHashes.set(sourceHash, finalTargetPath);
      copiedCount++;

      if (finalTargetPath !== targetPath) {
        this.globalStats.filesRenamedForConflicts++;
        if (this.verbose) {
          console.log(chalk.yellow(`  Renamed due to filename conflict: ${path.basename(targetPath)} → ${path.basename(finalTargetPath)}`));
        }
      }
    }

    // Update cache with newly copied files
    if (copiedCount > 0) {
      await this.updateCacheWithNewFiles(sourceFiles, sourceHashes, targetHashes);
    }

    copySpinner.succeed(`Copied ${copiedCount} unique files, skipped ${this.globalStats.duplicatesSkipped} duplicates`);

    return copiedCount;
  }

  async scanAllFiles(directory) {
    const files = [];

    const scanRecursive = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanRecursive(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    };

    await scanRecursive(directory);
    return files;
  }

  async buildHashDatabase(files) {
    const hashes = new Map();
    const organizer = new PhotoOrganizer({ baseDirectory: '.' });

    const spinner = ora(`Building hash database for ${files.length} source files...`).start();
    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Update progress every 10 files or at milestones
      if (i % 10 === 0 || i === files.length - 1) {
        const progress = ((i + 1) / files.length * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (i + 1) / elapsed;
        const eta = files.length > i + 1 ? Math.ceil((files.length - i - 1) / rate) : 0;

        spinner.text = `Building source hash database: ${i + 1}/${files.length} (${progress}%) - ${rate.toFixed(1)} files/sec - ETA: ${eta}s - ${path.basename(file)}`;
      }

      try {
        const hash = await organizer.createFileFingerprint(file);
        hashes.set(file, hash);
      } catch (error) {
        if (this.verbose) {
          console.log(chalk.gray(`Warning: Could not hash ${path.basename(file)}: ${error.message}`));
        }
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    spinner.succeed(`Built hash database for ${files.length} source files in ${totalTime.toFixed(1)}s`);
    return hashes;
  }

  async buildTargetHashDatabase() {
    const hashes = new Map();

    if (!await fs.pathExists(this.targetDirectory)) {
      return hashes; // Empty database if target doesn't exist
    }

    // Try to load cached hash database
    const cachedHashes = await this.loadHashCache();
    const targetFiles = await this.scanAllFiles(this.targetDirectory);

    if (targetFiles.length === 0) {
      return hashes; // No files to hash
    }

    // Build file modification time map for cache validation
    const fileModTimes = new Map();
    for (const file of targetFiles) {
      try {
        const stats = await fs.stat(file);
        fileModTimes.set(file, stats.mtime.getTime());
      } catch (error) {
        // Skip files that can't be stat'd
      }
    }

    // Determine which files need to be hashed
    const filesToHash = [];
    const validCachedHashes = new Map();

    for (const file of targetFiles) {
      const currentModTime = fileModTimes.get(file);
      const cachedEntry = cachedHashes.get(file);

      if (cachedEntry && cachedEntry.modTime === currentModTime) {
        // File hasn't changed, use cached hash
        validCachedHashes.set(cachedEntry.hash, file);
      } else {
        // File is new or modified, needs hashing
        filesToHash.push(file);
      }
    }

    console.log(chalk.green(`📋 Cache status: ${validCachedHashes.size} files cached, ${filesToHash.length} files need hashing`));

    if (filesToHash.length === 0) {
      console.log(chalk.green(`✅ Using cached hash database for all ${targetFiles.length} target files`));
      return validCachedHashes;
    }

    // Hash the remaining files
    const organizer = new PhotoOrganizer({ baseDirectory: '.' });
    const spinner = ora(`Building hash database for ${filesToHash.length} new/modified files...`).start();
    const startTime = Date.now();

    const newCacheEntries = new Map();

    for (let i = 0; i < filesToHash.length; i++) {
      const file = filesToHash[i];

      // Update progress every 25 files or at milestones
      if (i % 25 === 0 || i === filesToHash.length - 1) {
        const progress = ((i + 1) / filesToHash.length * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (i + 1) / elapsed;
        const eta = filesToHash.length > i + 1 ? Math.ceil((filesToHash.length - i - 1) / rate) : 0;

        spinner.text = `Hashing new files: ${i + 1}/${filesToHash.length} (${progress}%) - ${rate.toFixed(1)} files/sec - ETA: ${eta}s`;
      }

      try {
        const hash = await organizer.createFileFingerprint(file);
        const modTime = fileModTimes.get(file);

        validCachedHashes.set(hash, file);
        newCacheEntries.set(file, { hash, modTime });
      } catch (error) {
        // Skip files that can't be hashed
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    spinner.succeed(`Hashed ${filesToHash.length} new files in ${totalTime.toFixed(1)}s`);

    // Update cache with new entries
    await this.updateHashCache(newCacheEntries, validCachedHashes);

    return validCachedHashes;
  }

  async loadHashCache() {
    try {
      if (await fs.pathExists(this.hashCacheFile)) {
        const cacheData = await fs.readJson(this.hashCacheFile);
        const cache = new Map();

        // Convert array back to Map
        if (cacheData.entries && Array.isArray(cacheData.entries)) {
          for (const [file, entry] of cacheData.entries) {
            cache.set(file, entry);
          }
        }

        console.log(chalk.green(`📋 Loaded hash cache with ${cache.size} entries`));
        return cache;
      }
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not load hash cache: ${error.message}`));
    }

    return new Map();
  }

  async updateHashCache(newEntries, allHashes) {
    try {
      // Load existing cache
      const existingCache = await this.loadHashCache();

      // Add new entries
      for (const [file, entry] of newEntries) {
        existingCache.set(file, entry);
      }

      // Remove entries for files that no longer exist
      const currentFiles = new Set();
      for (const file of allHashes.values()) {
        currentFiles.add(file);
      }

      for (const file of existingCache.keys()) {
        if (!currentFiles.has(file)) {
          existingCache.delete(file);
        }
      }

      // Save updated cache
      const cacheData = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        entries: Array.from(existingCache.entries())
      };

      await fs.writeJson(this.hashCacheFile, cacheData, { spaces: 2 });
      console.log(chalk.green(`💾 Updated hash cache with ${existingCache.size} entries`));

    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not save hash cache: ${error.message}`));
    }
  }

  async updateCacheWithNewFiles(sourceFiles, sourceHashes, targetHashes) {
    try {
      // Load existing cache
      const existingCache = await this.loadHashCache();

      // Add entries for newly copied files
      let newEntries = 0;
      for (const [hash, targetFile] of targetHashes) {
        if (!existingCache.has(targetFile)) {
          try {
            const stats = await fs.stat(targetFile);
            existingCache.set(targetFile, {
              hash: hash,
              modTime: stats.mtime.getTime()
            });
            newEntries++;
          } catch (error) {
            // Skip files that can't be stat'd
          }
        }
      }

      // Save updated cache
      const cacheData = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        entries: Array.from(existingCache.entries())
      };

      await fs.writeJson(this.hashCacheFile, cacheData, { spaces: 2 });
      console.log(chalk.green(`💾 Updated cache with ${newEntries} new files (${existingCache.size} total entries)`));

    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not update hash cache: ${error.message}`));
    }
  }

  async invalidateHashCache() {
    try {
      if (await fs.pathExists(this.hashCacheFile)) {
        await fs.remove(this.hashCacheFile);
        console.log(chalk.gray(`🗑️  Invalidated hash cache (will rebuild on next run)`));
      }
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Could not invalidate hash cache: ${error.message}`));
    }
  }

  async findUniqueFilename(targetPath) {
    if (!await fs.pathExists(targetPath)) {
      return targetPath;
    }

    const ext = path.extname(targetPath);
    const baseName = path.basename(targetPath, ext);
    const dir = path.dirname(targetPath);

    // Extract date pattern and counter from the filename (e.g., "2023-01-15_001")
    const dateCounterMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})_(\d{3})$/);

    if (!dateCounterMatch) {
      // If filename doesn't match expected pattern, just find next available name
      let counter = 1;
      let newPath = path.join(dir, `${baseName}_${String(counter).padStart(3, '0')}${ext}`);

      while (await fs.pathExists(newPath)) {
        counter++;
        newPath = path.join(dir, `${baseName}_${String(counter).padStart(3, '0')}${ext}`);
      }

      return newPath;
    }

    const [, datePrefix, counterStr] = dateCounterMatch;
    let counter = parseInt(counterStr, 10);

    // Find the next available counter for this date
    while (true) {
      counter++;
      const newFilename = `${datePrefix}_${String(counter).padStart(3, '0')}${ext}`;
      const newPath = path.join(dir, newFilename);

      if (!await fs.pathExists(newPath)) {
        return newPath;
      }
    }
  }

  async handleDuplicatesAndOrganize(organizer) {
    // Reset stats for this operation
    organizer.stats = {
      imagesProcessed: 0,
      videosProcessed: 0,
      filesRenamed: 0,
      filesMoved: 0,
      jsonFilesRemoved: 0,
      emptyDirsRemoved: 0,
      liveVideosRemoved: 0,
      duplicatesRemoved: 0,
      errors: 0
    };

    // Step 1: Scan all files recursively
    const allFiles = await organizer.scanFiles();

    // Step 2: Filter for image files for duplicate detection
    const imageFiles = allFiles.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return organizer.imageExtensions.has(ext);
    });

    // Step 3: Handle filename-based duplicates if we have image files
    let filesToProcess = allFiles;
    if (imageFiles.length > 0) {
      const keptImageFiles = await organizer.handleFilenameDuplicates(imageFiles);
      console.log(chalk.green(`✅ Filename duplicate handling complete: ${organizer.stats.duplicatesRemoved} duplicates removed`));

      // Replace image files in the full file list with the kept ones
      const nonImageFiles = allFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return !organizer.imageExtensions.has(ext);
      });
      filesToProcess = [...keptImageFiles, ...nonImageFiles];
    }

    // Step 4: Process remaining files (organize them)
    await organizer.processFiles(filesToProcess);

    // Step 5: Remove empty directories
    await organizer.removeEmptyDirectories();
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
    this.globalStats.totalDuplicatesRemoved += stats.duplicatesRemoved || 0;
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
      if (this.globalStats.filesRenamedForConflicts > 0) {
        console.log(chalk.yellow(`🔄 Files renamed to avoid conflicts: ${this.globalStats.filesRenamedForConflicts}`));
      }
      if (this.globalStats.duplicatesSkipped > 0) {
        console.log(chalk.cyan(`⏭️  Duplicates skipped (EXIF-based): ${this.globalStats.duplicatesSkipped}`));
      }
      console.log(chalk.green(`🗑️  Total JSON files removed: ${this.globalStats.totalJsonFilesRemoved}`));
      console.log(chalk.green(`🎥 Total live videos removed: ${this.globalStats.totalLiveVideosRemoved}`));
      if (this.globalStats.totalDuplicatesRemoved > 0) {
        console.log(chalk.green(`🔄 Total duplicates removed: ${this.globalStats.totalDuplicatesRemoved}`));
      }
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
