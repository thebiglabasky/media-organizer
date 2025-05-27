#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const PhotoOrganizer = require('./organizer');
const BatchProcessor = require('./batch-processor');

const program = new Command();

program
  .name('photo-organizer')
  .description('Organize and rename photos and videos based on EXIF/filename dates')
  .version('1.0.0');

program
  .argument('<directory>', 'Base directory to scan for photos and videos')
  .option('-d, --dry-run', 'Show what would be done without making changes', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('-t, --detailed-timestamp', 'Use detailed timestamp format (YYYY-MM-DD-HH-MM) instead of date only', false)
  .action(async (directory, options) => {
    console.log(chalk.blue.bold('📸 Photo & Video Organizer'));
    console.log(chalk.gray(`Scanning: ${directory}`));

    if (options.dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No files will be modified'));
    }

    const spinner = ora('Initializing...').start();

    try {
      const organizer = new PhotoOrganizer({
        baseDirectory: directory,
        dryRun: options.dryRun,
        verbose: options.verbose,
        useDetailedTimestamp: options.detailedTimestamp
      });

      await organizer.organize();
      spinner.succeed(chalk.green('✅ Organization complete!'));

    } catch (error) {
      spinner.fail(chalk.red(`❌ Error: ${error.message}`));
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('cleanup-live')
  .description('Remove .mov files that match photo names (live photos)')
  .argument('<directory>', 'Base directory to scan for live videos')
  .option('-d, --dry-run', 'Show what would be done without making changes', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('--debug', 'Show detailed matching information for each file pair', false)
  .action(async (directory, options) => {
    console.log(chalk.blue.bold('🎥 Live Video Cleanup'));
    console.log(chalk.gray(`Scanning: ${directory}`));

    if (options.dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No files will be modified'));
    }

    if (options.debug) {
      console.log(chalk.cyan('🐛 DEBUG MODE - Showing detailed matching information'));
    }

    const spinner = ora('Initializing...').start();

    try {
      const organizer = new PhotoOrganizer({
        baseDirectory: directory,
        dryRun: options.dryRun,
        verbose: options.verbose,
        debug: options.debug
      });

      await organizer.cleanupLiveVideos();
      spinner.succeed(chalk.green('✅ Live video cleanup complete!'));

    } catch (error) {
      spinner.fail(chalk.red(`❌ Error: ${error.message}`));
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('batch')
  .description('Process multiple zip files containing Google Photos takeouts')
  .argument('<source-directory>', 'Directory containing zip files to process')
  .argument('<target-directory>', 'Target directory to merge organized photos')
  .option('-p, --progressive', 'Process one zip file at a time (wait for Enter between files)', false)
  .option('-t, --detailed-timestamp', 'Use detailed timestamp format (YYYY-MM-DD-HH-MM) instead of date only', false)
  .option('-s, --suffix <suffix>', 'Suffix to detect duplicates (e.g., "_edited"). Keep suffixed version, remove original before organizing', '-modifié')
  .action(async (sourceDirectory, targetDirectory, options, command) => {
    console.log(chalk.blue.bold('📦 Batch Photo Organizer'));
    console.log(chalk.gray(`Source: ${sourceDirectory}`));
    console.log(chalk.gray(`Target: ${targetDirectory}`));

    if (program.opts().dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No files will be modified'));
    }

    if (options.progressive) {
      console.log(chalk.cyan('⏯️  PROGRESSIVE MODE - Processing one zip at a time'));
    }

    if (options.suffix) {
      console.log(chalk.cyan(`🔄 DUPLICATE HANDLING - Keeping files with suffix "${options.suffix}", removing originals before organizing`));
    }

    const spinner = ora('Initializing batch processor...').start();

    try {
      const processor = new BatchProcessor({
        sourceDirectory,
        targetDirectory,
        dryRun: program.opts().dryRun,
        verbose: program.opts().verbose,
        progressive: options.progressive,
        useDetailedTimestamp: options.detailedTimestamp,
        duplicateSuffix: options.suffix
      });

      spinner.stop();
      await processor.processBatch();
      console.log(chalk.green('✅ Batch processing complete!'));

    } catch (error) {
      spinner.fail(chalk.red(`❌ Error: ${error.message}`));
      if (program.opts().verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('rename-by-exif')
  .description('Recursively rename image files based on EXIF metadata date/time')
  .argument('<directory>', 'Directory to scan recursively for image files')
  .option('-d, --dry-run', 'Show what would be done without making changes', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('-s, --suffix <suffix>', 'Suffix to detect duplicates (e.g., "_edited"). Keep suffixed version, remove original')
  .option('-t, --detailed-timestamp', 'Use detailed timestamp format (YYYY-MM-DD-HH-MM) - enabled by default for this command', true)
  .action(async (directory, options) => {
    console.log(chalk.blue.bold('📷 EXIF-based File Renamer'));
    console.log(chalk.gray(`Scanning: ${directory}`));

    if (options.dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No files will be modified'));
    }

    if (options.suffix) {
      console.log(chalk.cyan(`🔄 DUPLICATE HANDLING - Keeping files with suffix "${options.suffix}", removing originals`));
    }

    try {
      const organizer = new PhotoOrganizer({
        baseDirectory: directory,
        dryRun: options.dryRun,
        verbose: options.verbose,
        renameByExif: true,
        duplicateSuffix: options.suffix,
        useDetailedTimestamp: options.detailedTimestamp
      });

      await organizer.renameByExif();
      console.log(chalk.green('✅ EXIF-based renaming complete!'));

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('remove-duplicates')
  .description('Find and remove duplicate images based on EXIF metadata and file size')
  .argument('<directory>', 'Directory to scan recursively for duplicate images')
  .option('-d, --dry-run', 'Show what would be done without making changes', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('--videos-only', 'Only check videos for duplicates based on filename date pattern and file size', false)
  .action(async (directory, options) => {
    const fileType = options.videosOnly ? 'Video' : 'Image';
    console.log(chalk.blue.bold(`🔍 Duplicate ${fileType} Remover`));
    console.log(chalk.gray(`Scanning: ${directory}`));

    if (options.dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No files will be modified'));
    }

    if (options.videosOnly) {
      console.log(chalk.cyan('🎬 VIDEO MODE - Only checking videos with date patterns'));
    }

    try {
      const organizer = new PhotoOrganizer({
        baseDirectory: directory,
        dryRun: options.dryRun,
        verbose: options.verbose,
        videosOnly: options.videosOnly
      });

      await organizer.removeDuplicates();
      console.log(chalk.green('✅ Duplicate removal complete!'));

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command('clear-cache')
  .description('Clear the hash cache for batch processing target directory')
  .argument('<target-directory>', 'Target directory whose cache should be cleared')
  .action(async (targetDirectory, options) => {
    console.log(chalk.blue.bold('🗑️  Cache Cleaner'));
    console.log(chalk.gray(`Target: ${targetDirectory}`));

    try {
      const processor = new BatchProcessor({
        sourceDirectory: '.',  // Not used for cache clearing
        targetDirectory,
        dryRun: false,
        verbose: false
      });

      await processor.invalidateHashCache();
      console.log(chalk.green('✅ Cache cleared successfully!'));

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
