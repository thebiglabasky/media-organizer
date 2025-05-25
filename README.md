# Photo Organizer CLI

A command-line tool to organize and rename photos based on their EXIF creation date.

## Features

- ✅ Recursively scans directories for photo and video files
- ✅ Renames files using YYYY-MM-DD_XXX format based on EXIF creation date
- ✅ Organizes files into year/month folder structure
- ✅ Removes JSON files found during scanning
- ✅ Supports dry-run mode for safe testing
- ✅ Beautiful CLI interface with progress indicators using Chalk and Ora
- ✅ Comprehensive error handling and statistics
- ✅ Video support with filename pattern parsing
- ✅ GIF support using filename patterns (since EXIF is unreliable)
- ✅ Automatic cleanup of empty directories after organization

## Installation

```bash
npm install
chmod +x src/index.js
```

## Usage

```bash
# Basic usage
node src/index.js /path/to/photos

# Dry run (RECOMMENDED FIRST)
node src/index.js /path/to/photos --dry-run

# Verbose output
node src/index.js /path/to/photos --verbose

# Dry run with verbose output
node src/index.js /path/to/photos --dry-run --verbose
```

## Supported Formats

### Images (EXIF-based)
- JPEG (.jpg, .jpeg)
- PNG (.png)
- TIFF (.tiff, .tif)
- BMP (.bmp)
- WebP (.webp)
- HEIC/HEIF (.heic, .heif)
- RAW formats (.raw, .cr2, .nef, .arw, .dng)

### Videos (filename pattern + metadata)
- MP4 (.mp4)
- AVI (.avi)
- MOV (.mov)
- MKV (.mkv)
- WMV (.wmv)
- FLV (.flv)
- WebM (.webm)
- M4V (.m4v)

### Pattern-based (filename parsing)
- GIF (.gif) - uses filename patterns since EXIF is unreliable

## Date Extraction Methods

### For Images (EXIF-based)
The tool prioritizes EXIF date fields in this order:
1. `DateTimeOriginal` - When photo was taken
2. `CreateDate` - Alternative creation date
3. `DateTime` - File modification date in camera
4. `DateTimeDigitized` - When photo was digitized

### For Videos and GIFs (Pattern-based only)
The tool looks for date patterns in filenames:
1. `20220416_073730.mp4` → 2022-04-16
2. `VID_20200624_205041.avi` → 2020-06-24
3. Any `YYYYMMDD` pattern (years 2009-2025)

**Note**: Video metadata is not used as it often contains file creation dates rather than actual recording dates.

### Fallback
If no EXIF date or filename pattern is found, falls back to file modification time.

## File Organization

Files will be organized as:
```
base-directory/
├── 2023/
│   ├── 01/
│   │   ├── 2023-01-15_001.jpg
│   │   └── 2023-01-15_002.jpg
│   └── 02/
│       └── 2023-02-10_001.jpg
└── 2024/
    └── 03/
        └── 2024-03-20_001.jpg
```

## Dependencies

- `chalk` - Terminal colors and styling
- `ora` - Progress spinners
- `commander` - CLI argument parsing
- `exifr` - EXIF metadata extraction
- `fs-extra` - Enhanced file system operations
