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
        verbose: options.verbose
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

    const spinner = ora('Initializing batch processor...').start();

    try {
      const processor = new BatchProcessor({
        sourceDirectory,
        targetDirectory,
        dryRun: program.opts().dryRun,
        verbose: program.opts().verbose,
        progressive: options.progressive
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

program.parse(process.argv);
