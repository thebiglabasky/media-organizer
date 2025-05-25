const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const exifr = require('exifr');

class PhotoOrganizer {
  constructor(options) {
    this.baseDirectory = path.resolve(options.baseDirectory);
    this.dryRun = options.dryRun || false;
    this.verbose = options.verbose || false;

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
      // Extract EXIF data
      const exifData = await exifr.parse(filePath);
      let creationDate = this.extractCreationDate(exifData, filePath);

      if (!creationDate) {
        // Fallback to file modification time if no EXIF date
        const stats = await fs.stat(filePath);
        creationDate = stats.mtime;
        this.log(`No EXIF date found for ${path.basename(filePath)}, using file mtime`);
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
    const ext = path.extname(originalPath);
    const year = creationDate.getFullYear();
    const month = String(creationDate.getMonth() + 1).padStart(2, '0');
    const day = String(creationDate.getDate()).padStart(2, '0');

    // Create target directory structure: baseDirectory/YYYY/MM/
    const targetDir = path.join(this.baseDirectory, String(year), month);

    // Generate base filename: YYYY-MM-DD
    const baseFilename = `${year}-${month}-${day}`;

    // Find unique filename by adding counter if needed
    let counter = 1;
    let newFilename = `${baseFilename}_${String(counter).padStart(3, '0')}${ext}`;
    let newPath = path.join(targetDir, newFilename);

    while (await fs.pathExists(newPath)) {
      counter++;
      newFilename = `${baseFilename}_${String(counter).padStart(3, '0')}${ext}`;
      newPath = path.join(targetDir, newFilename);
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
    console.log(chalk.green(`📂 Empty dirs removed: ${this.stats.emptyDirsRemoved}`));

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
}

module.exports = PhotoOrganizer;
