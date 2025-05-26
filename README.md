# Photo Organizer CLI

A powerful command-line tool to organize and rename photos and videos based on their EXIF creation date, with support for batch processing Google Photos takeouts.

## Features

- ✅ **Smart Date Detection**: Uses EXIF data for images, filename patterns for videos/GIFs
- ✅ **Batch Processing**: Process multiple Google Photos takeout zip files automatically
- ✅ **Progressive Mode**: Process zip files one at a time with user control
- ✅ **Live Photo Cleanup**: Remove .mov files that match photo names (iPhone live photos)
- ✅ **Intelligent Organization**: Year/month folder structure with sequential numbering
- ✅ **Dry Run Mode**: Safe testing without making any changes
- ✅ **Comprehensive Statistics**: Detailed reporting of all operations
- ✅ **Error Recovery**: Robust error handling with cleanup on failures
- ✅ **Interactive Controls**: Quit anytime with 'Q' or Ctrl+C in progressive mode

## Installation

```bash
npm install
```

## Commands

### 1. Organize Photos & Videos

Organize photos and videos in a directory based on their creation dates.

```bash
# Basic usage
node src/index.js <directory> [options]

# Examples
node src/index.js /path/to/photos
node src/index.js /path/to/photos --dry-run --verbose
```

**Options:**
- `-d, --dry-run` - Show what would be done without making changes
- `-v, --verbose` - Show detailed output during processing

### 2. Live Photo Cleanup

Remove .mov files that match photo names (iPhone live photos).

```bash
node src/index.js cleanup-live <directory> [options]

# Examples
node src/index.js cleanup-live /path/to/photos --dry-run
node src/index.js cleanup-live /path/to/photos --debug --verbose
```

**Options:**
- `-d, --dry-run` - Show what would be done without making changes
- `-v, --verbose` - Show detailed output during processing
- `--debug` - Show detailed matching information for each file pair

### 3. Batch Processing (Google Photos Takeouts)

Process multiple Google Photos takeout zip files automatically.

```bash
node src/index.js batch <source-directory> <target-directory> [options]

# Examples
node src/index.js batch /Users/john/Downloads /Users/john/Photos
node src/index.js batch /Downloads /Photos --progressive
```

**Options:**
- `-p, --progressive` - Process one zip file at a time (interactive mode)
- Global options (`--dry-run`, `--verbose`) also apply

#### Progressive Mode Controls
When using `--progressive` mode:
- **Enter/Space** - Continue to next zip file
- **Q** - Quit gracefully (shows final statistics)
- **Ctrl+C** - Immediate exit

#### How Batch Processing Works
1. **Extraction**: Each zip file is extracted to a temporary directory
2. **Detection**: Automatically finds the Google Photos folder within Takeout structure
3. **Organization**: Organizes photos by date using the same logic as the main command
4. **Merging**: Copies organized files to the target directory (incremental, no duplicates)
5. **Cleanup**: Removes temporary files and original zip files after successful processing

## Supported File Formats

### Images (EXIF-based date detection)
- JPEG (.jpg, .jpeg)
- PNG (.png)
- TIFF (.tiff, .tif)
- BMP (.bmp)
- WebP (.webp)
- HEIC/HEIF (.heic, .heif)
- RAW formats (.raw, .cr2, .nef, .arw, .dng)

### Videos (filename pattern-based)
- MP4 (.mp4)
- AVI (.avi)
- MOV (.mov)
- MKV (.mkv)
- WMV (.wmv)
- FLV (.flv)
- WebM (.webm)
- M4V (.m4v)

### Other formats
- GIF (.gif) - uses filename patterns (EXIF unreliable for GIFs)

## Date Detection Strategy

### Images (EXIF Priority Order)
1. `DateTimeOriginal` - When photo was actually taken
2. `CreateDate` - Alternative creation date
3. `DateTime` - File modification date in camera
4. `DateTimeDigitized` - When photo was digitized

### Videos & GIFs (Filename Patterns)
Recognizes these patterns in filenames:
- `20220416_073730.mp4` → 2022-04-16
- `VID_20200624_205041.avi` → 2020-06-24
- `IMG_20210315_142530.gif` → 2021-03-15
- Any `YYYYMMDD` pattern (years 2009-2025)

**Note**: Video metadata is not used as it often contains file creation dates rather than actual recording dates.

### Fallback
If no EXIF date or filename pattern is found, uses file modification time.

## File Organization Structure

Files are organized into a year/month hierarchy with sequential numbering:

```
target-directory/
├── 2023/
│   ├── 01/                    # January 2023
│   │   ├── 2023-01-15_001.jpg
│   │   ├── 2023-01-15_002.jpg
│   │   └── 2023-01-20_001.mp4
│   └── 02/                    # February 2023
│       └── 2023-02-10_001.jpg
└── 2024/
    └── 03/                    # March 2024
        ├── 2024-03-20_001.heic
        └── 2024-03-20_002.mov
```

## Statistics & Reporting

All commands provide comprehensive statistics:

- **Files processed** (images, videos, total)
- **Files moved and renamed**
- **JSON files removed** (Google Photos metadata)
- **Live videos removed** (cleanup command)
- **Empty directories removed**
- **Errors encountered**
- **Files copied to target** (batch mode)

## Error Handling

- **Graceful recovery**: Errors with individual files don't stop processing
- **Cleanup on failure**: Temporary files are removed even if processing fails
- **Progressive mode safety**: Errors stop processing to allow manual intervention
- **Detailed error reporting**: Verbose mode shows full error details

## Dependencies

```json
{
  "chalk": "^4.1.2",
  "ora": "^5.4.1",
  "commander": "^9.4.1",
  "exifr": "^7.1.3",
  "fs-extra": "^10.1.0",
  "yauzl": "^2.10.0"
}
```

## Tips & Best Practices

1. **Always test first**: Use `--dry-run` to see what will happen
2. **Use progressive mode**: For large batch operations, use `--progressive` to control the process
3. **Check statistics**: Review the final statistics to ensure everything processed correctly
4. **Backup important data**: While the tool is safe, always backup irreplaceable photos
5. **Verbose output**: Use `--verbose` for troubleshooting or detailed progress information

## Common Use Cases

### Organizing a single photo library
```bash
node src/index.js /Users/john/Photos --dry-run --verbose
node src/index.js /Users/john/Photos
```

### Processing Google Photos takeouts
```bash
# Progressive mode for control
node src/index.js batch /Users/john/Downloads /Users/john/OrganizedPhotos --progressive

# Automatic processing
node src/index.js batch /Users/john/Downloads /Users/john/OrganizedPhotos
```

### Cleaning up iPhone live photos
```bash
node src/index.js cleanup-live /Users/john/Photos --dry-run --debug
node src/index.js cleanup-live /Users/john/Photos
```
