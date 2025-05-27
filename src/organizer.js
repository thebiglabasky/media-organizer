const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const exifr = require('exifr');
const crypto = require('crypto');

class PhotoOrganizer {
  constructor(options) {
    this.baseDirectory = path.resolve(options.baseDirectory);
    this.dryRun = options.dryRun || false;
    this.verbose = options.verbose || false;
    this.debug = options.debug || false;
    this.isExifRenameMode = options.renameByExif || false;
    this.duplicateSuffix = options.duplicateSuffix || null;
    this.useDetailedTimestamp = options.useDetailedTimestamp || false;
    this.videosOnly = options.videosOnly || false;

    // Supported image extensions
    this.imageExtensions = new Set([
      '.jpg', '.jpeg', '.png', '.tiff', '.tif',
      '.bmp', '.webp', '.heic', '.heif',
      '.raw', '.cr2', '.nef', '.arw', '.dng'
    ]);

    // Video extensions
    this.videoExtensions = new Set([
      '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v'
    ]);

    // Extensions that need filename pattern parsing
    this.filenamePatternExtensions = new Set([
      '.gif', '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v'
    ]);

    // Statistics
    this.stats = {
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
  }

  async organize() {
    // Validate base directory exists
    if (!await fs.pathExists(this.baseDirectory)) {
      throw new Error(`Directory does not exist: ${this.baseDirectory}`);
    }

    this.log(`Starting organization of: ${this.baseDirectory}`);

    // Step 1: Scan all files recursively
    const spinner = ora('Scanning files...').start();
    const files = await this.scanFiles();
    spinner.succeed(`Found ${files.length} files to process`);

    // Step 2: Process each file
    await this.processFiles(files);

    // Step 3: Remove empty directories
    await this.removeEmptyDirectories();

    // Step 4: Show final statistics
    this.showStatistics();
  }

  async scanFiles() {
    const files = [];

    const scanDirectory = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await scanDirectory(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    };

    await scanDirectory(this.baseDirectory);
    return files;
  }

  async processFiles(files) {
    const spinner = ora('Processing files...').start();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      spinner.text = `Processing ${i + 1}/${files.length}: ${path.basename(file)}`;

      try {
        await this.processFile(file);
      } catch (error) {
        this.stats.errors++;
        console.error(chalk.red(`❌ Error processing ${file}: ${error.message}`));
        if (this.verbose) {
          console.error(error.stack);
        }
      }
    }

    spinner.succeed('File processing complete');
  }

  async processFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);

    // Remove JSON files
    if (ext === '.json') {
      this.log(`Removing JSON file: ${filename}`);
      if (!this.dryRun) {
        await fs.remove(filePath);
      }
      this.stats.jsonFilesRemoved++;
      return;
    }

    // Process image files
    if (this.imageExtensions.has(ext)) {
      await this.processImageFile(filePath);
    }

    // Process video files and GIFs (using filename patterns)
    if (this.videoExtensions.has(ext) || ext === '.gif') {
      await this.processVideoOrPatternFile(filePath);
    }
  }

  async processImageFile(filePath) {
    this.stats.imagesProcessed++;

    try {
      let creationDate = null;

      // Try to extract EXIF data
      try {
        const exifData = await exifr.parse(filePath);
        creationDate = this.extractCreationDate(exifData, filePath);
      } catch (exifError) {
        this.log(`Could not parse EXIF data for ${path.basename(filePath)}: ${exifError.message}`);

        // Try filename pattern as fallback
        const ext = path.extname(filePath).toLowerCase();
        if (this.isExifRenameMode || ext === '.heic' || ext === '.heif') {
          creationDate = this.extractDateFromFilename(filePath);
          if (creationDate) {
            this.log(`Using filename pattern for: ${path.basename(filePath)}`);
          }
        }
      }

      if (!creationDate) {
        // Fallback to file modification time if no EXIF date or filename pattern
        const stats = await fs.stat(filePath);
        creationDate = stats.mtime;
        this.log(`No EXIF date or filename pattern found for ${path.basename(filePath)}, using file mtime`);
      }

      // Generate new filename and path
      const { newPath, newFilename } = await this.generateNewPath(filePath, creationDate);

      // Move and rename file
      if (newPath !== filePath) {
        await this.moveFile(filePath, newPath, newFilename);
      }

    } catch (error) {
      throw new Error(`Failed to process image ${path.basename(filePath)}: ${error.message}`);
    }
  }

  async processVideoOrPatternFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = this.videoExtensions.has(ext);

    if (isVideo) {
      this.stats.videosProcessed++;
    } else {
      this.stats.imagesProcessed++; // GIF counts as image
    }

    try {
      let creationDate = null;

      // For videos and GIFs, only use filename pattern extraction
      // Video metadata often contains file creation dates, not recording dates
      creationDate = this.extractDateFromFilename(filePath);

      if (!creationDate) {
        // Fallback to file modification time
        const stats = await fs.stat(filePath);
        creationDate = stats.mtime;
        this.log(`No date pattern or metadata found for ${path.basename(filePath)}, using file mtime`);
      }

      // Generate new filename and path
      const { newPath, newFilename } = await this.generateNewPath(filePath, creationDate);

      // Move and rename file
      if (newPath !== filePath) {
        await this.moveFile(filePath, newPath, newFilename);
      }

    } catch (error) {
      const fileType = isVideo ? 'video' : 'file';
      throw new Error(`Failed to process ${fileType} ${path.basename(filePath)}: ${error.message}`);
    }
  }

  extractDateFromFilename(filePath) {
    const filename = path.basename(filePath, path.extname(filePath));

    // Precise regex for years 2009-2025, months 01-12, days 01-31
    // This prevents matching random 8-digit sequences
    const datePattern = /(20(?:0[9]|1[0-9]|2[0-5]))(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])/;
    const match = filename.match(datePattern);

    if (match) {
      const [, year, month, day] = match;
      const date = this.validateAndCreateDate(year, month, day);
      if (date) {
        this.log(`Extracted date from filename pattern: ${date.toISOString().split('T')[0]} for ${path.basename(filePath)}`);
        return date;
      }
    }

    return null;
  }

  validateAndCreateDate(yearStr, monthStr, dayStr) {
    const year = parseInt(yearStr);
    const month = parseInt(monthStr);
    const day = parseInt(dayStr);

    // Validate year range (2009-2025)
    if (year < 2009 || year > 2025) {
      return null;
    }

    // Validate month (01-12)
    if (month < 1 || month > 12) {
      return null;
    }

    // Validate day (01-31)
    if (day < 1 || day > 31) {
      return null;
    }

    // Create date and validate it's actually valid (handles leap years, etc.)
    const date = new Date(year, month - 1, day); // month is 0-indexed in Date constructor

    if (date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day) {
      return date;
    }

    return null;
  }

  extractCreationDate(exifData, filePath) {
    if (!exifData) return null;

    // Try various EXIF date fields in order of preference
    const dateFields = [
      'DateTimeOriginal',    // When photo was taken
      'CreateDate',          // Alternative creation date
      'DateTime',            // File modification date in camera
      'DateTimeDigitized'    // When photo was digitized
    ];

    for (const field of dateFields) {
      if (exifData[field]) {
        const date = new Date(exifData[field]);
        if (!isNaN(date.getTime())) {
          this.log(`Using ${field} for ${path.basename(filePath)}: ${date.toISOString()}`);
          return date;
        }
      }
    }

    return null;
  }

  async generateNewPath(originalPath, creationDate) {
    const ext = path.extname(originalPath).toLowerCase();
    const year = creationDate.getFullYear();
    const month = String(creationDate.getMonth() + 1).padStart(2, '0');
    const day = String(creationDate.getDate()).padStart(2, '0');

    let targetDir;
    if (this.isExifRenameMode) {
      // For EXIF rename mode, keep files in their current directory
      targetDir = path.dirname(originalPath);
    } else {
      // For organize mode, create target directory structure: baseDirectory/YYYY/MM/
      targetDir = path.join(this.baseDirectory, String(year), month);
    }

    let baseFilename;
    if (this.useDetailedTimestamp) {
      // Generate detailed filename: YYYY-MM-DD-HH-MM
      const hour = String(creationDate.getHours()).padStart(2, '0');
      const minute = String(creationDate.getMinutes()).padStart(2, '0');
      baseFilename = `${year}-${month}-${day}-${hour}-${minute}`;
    } else {
      // Generate basic filename: YYYY-MM-DD
      baseFilename = `${year}-${month}-${day}`;
    }

    // Find unique filename by adding counter if needed
    let counter = 1;
    let newFilename = `${baseFilename}_${String(counter).padStart(3, '0')}${ext}`;
    let newPath = path.join(targetDir, newFilename);

    // Ensure the target directory exists before checking for conflicts
    await fs.ensureDir(targetDir);

    // For EXIF rename mode, skip conflict check if the new path is the same as original
    // (this prevents infinite loops when the file already has the correct name)
    while (await fs.pathExists(newPath) && newPath !== originalPath) {
      counter++;
      newFilename = `${baseFilename}_${String(counter).padStart(3, '0')}${ext}`;
      newPath = path.join(targetDir, newFilename);

      // Safety mechanism: prevent infinite loops
      if (counter > 9999) {
        throw new Error(`Too many filename conflicts for ${path.basename(originalPath)}. Counter exceeded 9999.`);
      }
    }

    return { newPath, newFilename };
  }

  async moveFile(oldPath, newPath, newFilename) {
    const targetDir = path.dirname(newPath);

    this.log(`Moving: ${path.basename(oldPath)} → ${path.relative(this.baseDirectory, newPath)}`);

    if (!this.dryRun) {
      // Ensure target directory exists
      await fs.ensureDir(targetDir);

      // Move the file
      await fs.move(oldPath, newPath);
    }

    this.stats.filesMoved++;
    this.stats.filesRenamed++;
  }

  async removeEmptyDirectories() {
    const spinner = ora('Removing empty directories...').start();

    try {
      await this.removeEmptyDirsRecursive(this.baseDirectory);
      spinner.succeed(`Removed ${this.stats.emptyDirsRemoved} empty directories`);
    } catch (error) {
      spinner.fail(`Error removing empty directories: ${error.message}`);
      this.stats.errors++;
    }
  }

  async removeLiveVideos() {
    const spinner = ora('Scanning for live videos...').start();

    try {
      const files = await this.scanFiles();
      const liveVideos = await this.findLiveVideos(files);

      spinner.succeed(`Found ${liveVideos.length} live videos to remove`);

      if (liveVideos.length > 0) {
        await this.deleteLiveVideos(liveVideos);
      }
    } catch (error) {
      spinner.fail(`Error removing live videos: ${error.message}`);
      this.stats.errors++;
    }
  }

    async findLiveVideos(files) {
    const liveVideos = [];
    const photoFiles = new Map(); // Changed to Map to store photo file paths
    const videoFiles = [];

    // Separate photos and videos
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();

      if (this.imageExtensions.has(ext)) {
        const baseName = path.basename(file, ext);
        const dirName = path.dirname(file);
        const baseKey = path.join(dirName, baseName);
        photoFiles.set(baseKey, file); // Store the full photo path
      } else if (ext === '.mov') {
        videoFiles.push(file);
      }
    }

    // Find .mov files that have matching photo names
    for (const videoFile of videoFiles) {
      const baseName = path.basename(videoFile, '.mov');
      const dirName = path.dirname(videoFile);
      const baseKey = path.join(dirName, baseName);

      if (photoFiles.has(baseKey)) {
        const matchedPhoto = photoFiles.get(baseKey);
        liveVideos.push(videoFile);

        if (this.debug) {
          console.log(chalk.cyan(`🔍 Match found:`));
          console.log(chalk.gray(`   Photo: ${path.relative(this.baseDirectory, matchedPhoto)}`));
          console.log(chalk.gray(`   Video: ${path.relative(this.baseDirectory, videoFile)}`));
        } else {
          this.log(`Found live video: ${path.relative(this.baseDirectory, videoFile)}`);
        }
      }
    }

    if (this.debug && liveVideos.length > 0) {
      console.log(chalk.yellow(`\n📋 Summary: ${liveVideos.length} live videos will be removed:`));
      liveVideos.forEach((video, index) => {
        console.log(chalk.gray(`   ${index + 1}. ${path.relative(this.baseDirectory, video)}`));
      });
      console.log('');
    }

    return liveVideos;
  }

  async deleteLiveVideos(liveVideos) {
    const spinner = ora('Removing live videos...').start();

    for (let i = 0; i < liveVideos.length; i++) {
      const videoFile = liveVideos[i];
      spinner.text = `Removing ${i + 1}/${liveVideos.length}: ${path.basename(videoFile)}`;

      try {
        if (this.dryRun) {
          this.log(`Would remove live video: ${path.relative(this.baseDirectory, videoFile)}`);
        } else {
          this.log(`Removing live video: ${path.relative(this.baseDirectory, videoFile)}`);
          await fs.remove(videoFile);
        }

        this.stats.liveVideosRemoved++;
      } catch (error) {
        this.stats.errors++;
        console.error(chalk.red(`❌ Error removing ${videoFile}: ${error.message}`));
      }
    }

    if (this.dryRun) {
      spinner.succeed(`Would remove ${this.stats.liveVideosRemoved} live videos`);
    } else {
      spinner.succeed(`Removed ${this.stats.liveVideosRemoved} live videos`);
    }
  }

  async removeEmptyDirsRecursive(dir) {
    // Don't remove the base directory itself
    if (dir === this.baseDirectory) {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(dir, entry.name);
          await this.removeEmptyDirsRecursive(fullPath);
        }
      }
      return;
    }

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      // First, recursively process subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(dir, entry.name);
          await this.removeEmptyDirsRecursive(fullPath);
        }
      }

      // Check if directory is now empty
      const updatedEntries = await fs.readdir(dir);
      if (updatedEntries.length === 0) {
        this.log(`Removing empty directory: ${path.relative(this.baseDirectory, dir)}`);
        if (!this.dryRun) {
          await fs.rmdir(dir);
        }
        this.stats.emptyDirsRemoved++;
      }

    } catch (error) {
      // Directory might have been removed already or access denied
      this.log(`Could not process directory ${dir}: ${error.message}`);
    }
  }

  showStatistics() {
    console.log('\n' + chalk.blue.bold('📊 Summary:'));
    console.log(chalk.green(`📸 Images processed: ${this.stats.imagesProcessed}`));
    console.log(chalk.green(`🎬 Videos processed: ${this.stats.videosProcessed}`));
    console.log(chalk.green(`📁 Files moved: ${this.stats.filesMoved}`));
    console.log(chalk.green(`📝 Files renamed: ${this.stats.filesRenamed}`));
    console.log(chalk.green(`🗑️  JSON files removed: ${this.stats.jsonFilesRemoved}`));
    console.log(chalk.green(`🎥 Live videos removed: ${this.stats.liveVideosRemoved}`));
    console.log(chalk.green(`📂 Empty dirs removed: ${this.stats.emptyDirsRemoved}`));

    if (this.stats.duplicatesRemoved > 0) {
      console.log(chalk.green(`🔄 Duplicates removed: ${this.stats.duplicatesRemoved}`));
    }

    if (this.stats.errors > 0) {
      console.log(chalk.red(`❌ Errors: ${this.stats.errors}`));
    }

    if (this.dryRun) {
      console.log(chalk.yellow('\n🔍 This was a dry run - no files were actually modified'));
    }
  }

  log(message) {
    if (this.verbose) {
      console.log(chalk.gray(`📝 ${message}`));
    }
  }

  async cleanupLiveVideos() {
    // Validate base directory exists
    if (!await fs.pathExists(this.baseDirectory)) {
      throw new Error(`Directory does not exist: ${this.baseDirectory}`);
    }

    this.log(`Starting live video cleanup in: ${this.baseDirectory}`);

    // Reset stats for this operation
    this.stats = {
      imagesProcessed: 0,
      videosProcessed: 0,
      filesRenamed: 0,
      filesMoved: 0,
      jsonFilesRemoved: 0,
      emptyDirsRemoved: 0,
      liveVideosRemoved: 0,
      errors: 0
    };

    await this.removeLiveVideos();
    this.showLiveVideoStats();
  }

  showLiveVideoStats() {
    console.log('\n' + chalk.blue.bold('📊 Live Video Cleanup Summary:'));

    if (this.dryRun) {
      console.log(chalk.yellow(`🎥 Live videos that would be removed: ${this.stats.liveVideosRemoved}`));
      console.log(chalk.yellow('\n🔍 This was a dry run - no files were actually modified'));
    } else {
      console.log(chalk.green(`🎥 Live videos removed: ${this.stats.liveVideosRemoved}`));
    }

    if (this.stats.errors > 0) {
      console.log(chalk.red(`❌ Errors: ${this.stats.errors}`));
    }
  }

  async renameByExif() {
    // Validate base directory exists
    if (!await fs.pathExists(this.baseDirectory)) {
      throw new Error(`Directory does not exist: ${this.baseDirectory}`);
    }

    this.log(`Starting EXIF-based renaming in: ${this.baseDirectory}`);

    // Enable detailed timestamp for this operation
    this.useDetailedTimestamp = true;

    // Reset stats for this operation
    this.stats = {
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

    // Step 1: Scan all image files recursively
    const spinner = ora('Scanning for image files...').start();
    const allFiles = await this.scanFiles();
    const imageFiles = allFiles.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return this.imageExtensions.has(ext);
    });
    spinner.succeed(`Found ${imageFiles.length} image files to process`);

    // Step 2: Handle filename-based duplicates first if suffix is specified
    let filesToProcess = imageFiles;
    if (this.duplicateSuffix) {
      filesToProcess = await this.handleFilenameDuplicates(imageFiles);
    }

    // Step 3: Rename files based on EXIF data
    await this.renameFilesByExif(filesToProcess);

    // Step 4: Remove empty directories
    await this.removeEmptyDirectories();

    // Step 5: Show final statistics
    this.showExifRenameStats();
  }

  async handleFilenameDuplicates(imageFiles) {
    const spinner = ora('Detecting and handling filename-based duplicates...').start();

    // Group files by base filename (without suffix)
    const filenameGroups = new Map(); // baseFilename -> array of files with metadata
    const filesToKeep = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      spinner.text = `Analyzing ${i + 1}/${imageFiles.length}: ${path.basename(file)}`;

      try {
        const ext = path.extname(file);
        const fullBaseName = path.basename(file, ext);
        const hasSuffix = this.duplicateSuffix && fullBaseName.endsWith(this.duplicateSuffix);

        // Create base filename by removing suffix if present
        let baseFilename;
        if (hasSuffix) {
          baseFilename = fullBaseName.slice(0, -this.duplicateSuffix.length);
        } else {
          baseFilename = fullBaseName;
        }

        // Use directory + baseFilename + extension as the grouping key
        // This ensures files in different directories don't interfere
        const dirName = path.dirname(file);
        const groupKey = path.join(dirName, baseFilename + ext);

        if (!filenameGroups.has(groupKey)) {
          filenameGroups.set(groupKey, []);
        }

        filenameGroups.get(groupKey).push({
          path: file,
          hasSuffix: hasSuffix,
          mtime: (await fs.stat(file)).mtime,
          fullBaseName: fullBaseName
        });
      } catch (error) {
        this.stats.errors++;
        this.log(`Error analyzing ${path.basename(file)}: ${error.message}`);
        // Keep files that can't be analyzed
        filesToKeep.push(file);
      }
    }

    // Process filename-based duplicates: prefer suffixed versions, then oldest files
    let duplicatesRemoved = 0;

    for (const [groupKey, files] of filenameGroups) {
      if (files.length === 1) {
        // No duplicates, keep the file
        filesToKeep.push(files[0].path);
      } else {
        // Multiple files with same base filename - choose which to keep
        let fileToKeep;

        if (this.duplicateSuffix) {
          // If suffix is specified, prefer suffixed versions
          const suffixedFiles = files.filter(f => f.hasSuffix);
          const originalFiles = files.filter(f => !f.hasSuffix);

          if (suffixedFiles.length > 0) {
            // Keep the oldest suffixed file
            fileToKeep = suffixedFiles.sort((a, b) => a.mtime - b.mtime)[0];
            this.log(`Filename duplicate group: keeping suffixed version ${path.basename(fileToKeep.path)}`);
          } else {
            // No suffixed files, keep the oldest original
            fileToKeep = originalFiles.sort((a, b) => a.mtime - b.mtime)[0];
            this.log(`Filename duplicate group: keeping oldest original ${path.basename(fileToKeep.path)}`);
          }
        } else {
          // No suffix preference, keep the oldest file
          fileToKeep = files.sort((a, b) => a.mtime - b.mtime)[0];
          this.log(`Filename duplicate group: keeping oldest file ${path.basename(fileToKeep.path)}`);
        }

        filesToKeep.push(fileToKeep.path);

        // Remove the other files
        const filesToRemove = files.filter(f => f.path !== fileToKeep.path);
        for (const fileToRemove of filesToRemove) {
          try {
            if (this.dryRun) {
              this.log(`  Would remove filename duplicate: ${path.relative(this.baseDirectory, fileToRemove.path)}`);
            } else {
              this.log(`  Removing filename duplicate: ${path.relative(this.baseDirectory, fileToRemove.path)}`);
              await fs.remove(fileToRemove.path);
            }
            this.stats.duplicatesRemoved++;
            duplicatesRemoved++;
          } catch (error) {
            this.stats.errors++;
            console.error(chalk.red(`❌ Error removing filename duplicate ${fileToRemove.path}: ${error.message}`));
          }
        }
      }
    }

    spinner.succeed(`Processed ${duplicatesRemoved} filename duplicates, ${filesToKeep.length} files remaining`);
    return filesToKeep;
  }

  async handleDuplicates(imageFiles) {
    const spinner = ora('Detecting and handling content-based duplicates...').start();

    // Create fingerprints for all files
    const fingerprints = new Map(); // fingerprint -> array of files with metadata
    const filesToKeep = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      spinner.text = `Analyzing ${i + 1}/${imageFiles.length}: ${path.basename(file)}`;

      try {
        const fingerprint = await this.createFileFingerprint(file);
        const baseName = path.basename(file, path.extname(file));
        const hasSuffix = this.duplicateSuffix && baseName.endsWith(this.duplicateSuffix);

        if (!fingerprints.has(fingerprint)) {
          fingerprints.set(fingerprint, []);
        }

        fingerprints.get(fingerprint).push({
          path: file,
          hasSuffix: hasSuffix,
          mtime: (await fs.stat(file)).mtime
        });
      } catch (error) {
        this.stats.errors++;
        this.log(`Error analyzing ${path.basename(file)}: ${error.message}`);
        // Keep files that can't be analyzed
        filesToKeep.push(file);
      }
    }

    // Process duplicates: prefer suffixed versions, then oldest files
    let duplicatesRemoved = 0;

    for (const [fingerprint, files] of fingerprints) {
      if (files.length === 1) {
        // No duplicates, keep the file
        filesToKeep.push(files[0].path);
      } else {
        // Multiple files with same fingerprint - choose which to keep
        let fileToKeep;

        if (this.duplicateSuffix) {
          // If suffix is specified, prefer suffixed versions
          const suffixedFiles = files.filter(f => f.hasSuffix);
          const originalFiles = files.filter(f => !f.hasSuffix);

          if (suffixedFiles.length > 0) {
            // Keep the oldest suffixed file
            fileToKeep = suffixedFiles.sort((a, b) => a.mtime - b.mtime)[0];
            this.log(`Content duplicate group: keeping suffixed version ${path.basename(fileToKeep.path)}`);
          } else {
            // No suffixed files, keep the oldest original
            fileToKeep = originalFiles.sort((a, b) => a.mtime - b.mtime)[0];
            this.log(`Content duplicate group: keeping oldest original ${path.basename(fileToKeep.path)}`);
          }
        } else {
          // No suffix preference, keep the oldest file
          fileToKeep = files.sort((a, b) => a.mtime - b.mtime)[0];
          this.log(`Content duplicate group: keeping oldest file ${path.basename(fileToKeep.path)}`);
        }

        filesToKeep.push(fileToKeep.path);

        // Remove the other files
        const filesToRemove = files.filter(f => f.path !== fileToKeep.path);
        for (const fileToRemove of filesToRemove) {
          try {
            if (this.dryRun) {
              this.log(`  Would remove content duplicate: ${path.relative(this.baseDirectory, fileToRemove.path)}`);
            } else {
              this.log(`  Removing content duplicate: ${path.relative(this.baseDirectory, fileToRemove.path)}`);
              await fs.remove(fileToRemove.path);
            }
            this.stats.duplicatesRemoved++;
            duplicatesRemoved++;
          } catch (error) {
            this.stats.errors++;
            console.error(chalk.red(`❌ Error removing content duplicate ${fileToRemove.path}: ${error.message}`));
          }
        }
      }
    }

    spinner.succeed(`Processed ${duplicatesRemoved} content duplicates, ${filesToKeep.length} files remaining`);
    return filesToKeep;
  }

    async renameFilesByExif(files) {
    const spinner = ora(`Processing ${files.length} files...`).start();
    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        await this.processImageFile(file);

        // Update progress every 100 files or show percentage milestones
        if ((i + 1) % 100 === 0 || (i + 1) % Math.ceil(files.length / 20) === 0 || i === files.length - 1) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (i + 1) / elapsed;
          const eta = files.length > i + 1 ? Math.ceil((files.length - i - 1) / rate) : 0;
          const progress = ((i + 1) / files.length * 100).toFixed(1);

          spinner.text = `Processing: ${i + 1}/${files.length} (${progress}%) - ${rate.toFixed(1)} files/sec - ETA: ${eta}s`;
        }
      } catch (error) {
        this.stats.errors++;
        // Don't interrupt spinner for errors, just log them if verbose
        if (this.verbose) {
          spinner.stop();
          console.error(chalk.red(`❌ Error processing ${file}: ${error.message}`));
          spinner.start();
        }
      }
    }

    const totalTime = (Date.now() - startTime) / 1000;
    spinner.succeed(chalk.green(`Processed ${files.length} files in ${totalTime.toFixed(1)}s`));
  }


  showExifRenameStats() {
    console.log('\n' + chalk.blue.bold('📊 EXIF Rename Summary:'));
    console.log(chalk.green(`📸 Images processed: ${this.stats.imagesProcessed}`));
    console.log(chalk.green(`📝 Files renamed: ${this.stats.filesRenamed}`));

    if (this.duplicateSuffix) {
      console.log(chalk.green(`🗑️  Duplicates removed: ${this.stats.duplicatesRemoved}`));
    }

    if (this.stats.errors > 0) {
      console.log(chalk.red(`❌ Errors: ${this.stats.errors}`));
    }

    if (this.dryRun) {
      console.log(chalk.yellow('\n🔍 This was a dry run - no files were actually modified'));
    }
  }

  async removeDuplicates() {
    // Validate base directory exists
    if (!await fs.pathExists(this.baseDirectory)) {
      throw new Error(`Directory does not exist: ${this.baseDirectory}`);
    }

    this.log(`Starting duplicate detection in: ${this.baseDirectory}`);

    // Reset stats for this operation
    this.stats = {
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
    const fileType = this.videosOnly ? 'video' : 'image';
    const spinner = ora(`Scanning for ${fileType} files...`).start();
    const allFiles = await this.scanFiles();

    let filesToAnalyze;
    if (this.videosOnly) {
      filesToAnalyze = allFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return this.videoExtensions.has(ext);
      });
    } else {
      filesToAnalyze = allFiles.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return this.imageExtensions.has(ext);
      });
    }
    spinner.succeed(`Found ${filesToAnalyze.length} ${fileType} files to analyze`);

    // Step 2: Analyze files and create fingerprints
    const duplicateGroups = this.videosOnly
      ? await this.findDuplicatesByDateAndSize(filesToAnalyze)
      : await this.findDuplicatesByExifAndSize(filesToAnalyze);

    // Step 3: Remove duplicates
    await this.removeDuplicateFiles(duplicateGroups);

    // Step 4: Remove empty directories
    await this.removeEmptyDirectories();

    // Step 5: Show final statistics
    this.showDuplicateRemovalStats();
  }

  async findDuplicatesByExifAndSize(imageFiles) {
    const spinner = ora('Analyzing EXIF data and file sizes...').start();
    const fingerprints = new Map(); // fingerprint -> array of files
    const duplicateGroups = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      spinner.text = `Analyzing ${i + 1}/${imageFiles.length}: ${path.basename(file)}`;

      try {
        const fingerprint = await this.createFileFingerprint(file);

        if (!fingerprints.has(fingerprint)) {
          fingerprints.set(fingerprint, []);
        }
        fingerprints.get(fingerprint).push(file);

        this.stats.imagesProcessed++;
      } catch (error) {
        this.stats.errors++;
        this.log(`Error analyzing ${path.basename(file)}: ${error.message}`);
      }
    }

    // Find groups with duplicates
    for (const [fingerprint, files] of fingerprints) {
      if (files.length > 1) {
        duplicateGroups.push(files);
      }
    }

    spinner.succeed(`Found ${duplicateGroups.length} groups of duplicates`);
    return duplicateGroups;
  }

  async createFileFingerprint(filePath) {
    // Get file size
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    // Extract EXIF data
    let exifHash = 'no-exif';
    try {
      const exifData = await exifr.parse(filePath);
      if (exifData) {
        // Create a normalized EXIF object with only relevant metadata
        const relevantExif = {
          make: exifData.Make,
          model: exifData.Model,
          dateTime: exifData.DateTime || exifData.DateTimeOriginal || exifData.CreateDate,
          orientation: exifData.Orientation,
          exposureTime: exifData.ExposureTime,
          fNumber: exifData.FNumber,
          iso: exifData.ISO,
          focalLength: exifData.FocalLength,
          flash: exifData.Flash,
          whiteBalance: exifData.WhiteBalance,
          imageWidth: exifData.ImageWidth || exifData.ExifImageWidth,
          imageHeight: exifData.ImageHeight || exifData.ExifImageHeight
        };

        // Remove undefined values and create hash
        const cleanExif = Object.fromEntries(
          Object.entries(relevantExif).filter(([_, value]) => value !== undefined)
        );

        exifHash = crypto.createHash('md5')
          .update(JSON.stringify(cleanExif))
          .digest('hex');
      }
    } catch (error) {
      this.log(`Could not parse EXIF for ${path.basename(filePath)}: ${error.message}`);
    }

    // Combine file size and EXIF hash for fingerprint
    return `${fileSize}-${exifHash}`;
  }

  async findDuplicatesByDateAndSize(videoFiles) {
    const spinner = ora('Analyzing video dates and file sizes...').start();
    const fingerprints = new Map(); // fingerprint -> array of files
    const duplicateGroups = [];

    for (let i = 0; i < videoFiles.length; i++) {
      const file = videoFiles[i];
      spinner.text = `Analyzing ${i + 1}/${videoFiles.length}: ${path.basename(file)}`;

      try {
        const fingerprint = await this.createVideoFingerprint(file);

        if (fingerprint) { // Only process files with valid date patterns
          if (!fingerprints.has(fingerprint)) {
            fingerprints.set(fingerprint, []);
          }
          fingerprints.get(fingerprint).push(file);
        }

        this.stats.imagesProcessed++; // Using same counter for consistency
      } catch (error) {
        this.stats.errors++;
        this.log(`Error analyzing ${path.basename(file)}: ${error.message}`);
      }
    }

    // Find groups with duplicates
    for (const [fingerprint, files] of fingerprints) {
      if (files.length > 1) {
        duplicateGroups.push(files);
      }
    }

    spinner.succeed(`Found ${duplicateGroups.length} groups of video duplicates`);
    return duplicateGroups;
  }

    async createVideoFingerprint(filePath) {
    // Get file size
    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    // Extract date from filename pattern YYYY-MM-DD_XXX
    const filename = path.basename(filePath, path.extname(filePath));
    const datePattern = /^(\d{4}-\d{2}-\d{2})_\d+$/;
    const match = filename.match(datePattern);

    if (!match) {
      this.log(`No date pattern found in ${path.basename(filePath)}, skipping`);
      return null; // Skip files that don't match the expected pattern
    }

    const dateStr = match[1]; // Extract YYYY-MM-DD part

    // Validate the date
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!this.validateAndCreateDate(year.toString(), month.toString().padStart(2, '0'), day.toString().padStart(2, '0'))) {
      this.log(`Invalid date in filename ${path.basename(filePath)}, skipping`);
      return null;
    }

    // Combine file size and date for fingerprint (videos use date instead of EXIF)
    return `${fileSize}-video-${dateStr}`;
  }

  async removeDuplicateFiles(duplicateGroups) {
    if (duplicateGroups.length === 0) {
      console.log(chalk.green('✅ No duplicates found!'));
      return;
    }

    const spinner = ora('Removing duplicate files...').start();
    let totalDuplicatesRemoved = 0;

    for (const group of duplicateGroups) {
      // Sort files by modification time (keep the oldest as the "original")
      const sortedFiles = group.sort((a, b) => {
        const statsA = fs.statSync(a);
        const statsB = fs.statSync(b);
        return statsA.mtime - statsB.mtime;
      });

      const keepFile = sortedFiles[0]; // Keep the oldest file
      const duplicatesToRemove = sortedFiles.slice(1); // Remove the rest

      this.log(`Duplicate group found:`);
      this.log(`  Keeping: ${path.relative(this.baseDirectory, keepFile)}`);

      for (const duplicate of duplicatesToRemove) {
        try {
          if (this.dryRun) {
            this.log(`  Would remove: ${path.relative(this.baseDirectory, duplicate)}`);
          } else {
            this.log(`  Removing: ${path.relative(this.baseDirectory, duplicate)}`);
            await fs.remove(duplicate);
          }
          this.stats.duplicatesRemoved++;
          totalDuplicatesRemoved++;
        } catch (error) {
          this.stats.errors++;
          console.error(chalk.red(`❌ Error removing ${duplicate}: ${error.message}`));
        }
      }
    }

    spinner.succeed(`Processed ${duplicateGroups.length} duplicate groups`);
  }

  showDuplicateRemovalStats() {
    console.log('\n' + chalk.blue.bold('📊 Duplicate Removal Summary:'));

    if (this.videosOnly) {
      console.log(chalk.green(`🎬 Videos analyzed: ${this.stats.imagesProcessed}`));
    } else {
      console.log(chalk.green(`📸 Images analyzed: ${this.stats.imagesProcessed}`));
    }

    console.log(chalk.green(`🗑️  Duplicates removed: ${this.stats.duplicatesRemoved}`));

    if (this.stats.errors > 0) {
      console.log(chalk.red(`❌ Errors: ${this.stats.errors}`));
    }

    if (this.dryRun) {
      console.log(chalk.yellow('\n🔍 This was a dry run - no files were actually modified'));
    }
  }
}

module.exports = PhotoOrganizer;
