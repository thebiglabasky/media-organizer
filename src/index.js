#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const PhotoOrganizer = require('./organizer');

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

program.parse();
