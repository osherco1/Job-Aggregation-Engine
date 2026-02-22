/**
 * Cleanup utility for Comeet debug logs
 * 
 * Purpose: Delete debug log files (raw_, normalized_, error_, comeet_debug_run_summary_, *.tmp)
 * from logs/ats/comeet/debug folder
 * 
 * Usage:
 *   node tools/clean_comeet_debug_logs.js [--force]
 * 
 * Or via npm:
 *   npm run comeet:debug:clean
 *   npm run comeet:debug:clean -- --force
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PATHS } = require('../../config/paths');

// File prefixes to delete
const DELETE_PREFIXES = [
  'raw_',
  'normalized_',
  'error_',
  'comeet_debug_run_summary_',
];

// Additional patterns (e.g., *.tmp)
const DELETE_PATTERNS = [
  /\.tmp$/i, // Case-insensitive .tmp files
];

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    force: args.includes('--force'),
  };
}

/**
 * Check if a file should be deleted based on its name
 */
function shouldDeleteFile(fileName) {
  // Check prefixes
  for (const prefix of DELETE_PREFIXES) {
    if (fileName.startsWith(prefix)) {
      return true;
    }
  }

  // Check patterns
  for (const pattern of DELETE_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all files in directory that match deletion criteria
 */
function getFilesToDelete(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files = fs.readdirSync(dirPath);
  const filesToDelete = [];

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    // Only process files (not directories)
    if (stat.isFile() && shouldDeleteFile(file)) {
      filesToDelete.push({
        name: file,
        path: filePath,
        size: stat.size,
      });
    }
  }

  return filesToDelete;
}

/**
 * Prompt user for confirmation
 */
function promptConfirmation(filesCount) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      `⚠️  This will delete ${filesCount} file(s) from the debug folder. Continue? (y/n): `,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
      }
    );
  });
}

/**
 * Delete files
 */
function deleteFiles(filesToDelete) {
  const results = {
    deleted: 0,
    failed: 0,
    errors: [],
  };

  for (const file of filesToDelete) {
    try {
      fs.unlinkSync(file.path);
      results.deleted += 1;
    } catch (error) {
      results.failed += 1;
      results.errors.push({
        file: file.name,
        error: error.message || String(error),
      });
    }
  }

  return results;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Main execution
 */
async function main() {
  const args = parseArgs();
  const debugDir = PATHS.ATS.LOGS.COMEET.DEBUG;

  console.log('🧹 Comeet Debug Logs Cleanup');
  console.log('='.repeat(60));
  console.log(`📂 Target folder: ${debugDir}`);

  // Check if directory exists
  if (!fs.existsSync(debugDir)) {
    console.log(`   ℹ️  Debug folder does not exist. Nothing to clean.`);
    process.exit(0);
  }

  // Get files to delete
  const filesToDelete = getFilesToDelete(debugDir);

  if (filesToDelete.length === 0) {
    console.log(`   ✅ No files to delete. Debug folder is already clean.`);
    process.exit(0);
  }

  // Display files that will be deleted
  console.log(`\n📋 Files to delete (${filesToDelete.length}):`);
  const totalSize = filesToDelete.reduce((sum, f) => sum + f.size, 0);
  filesToDelete.forEach((file, index) => {
    console.log(`   ${index + 1}. ${file.name} (${formatFileSize(file.size)})`);
  });
  console.log(`   Total size: ${formatFileSize(totalSize)}`);

  // Prompt for confirmation (unless --force)
  let confirmed = args.force;
  if (!confirmed) {
    console.log('');
    confirmed = await promptConfirmation(filesToDelete.length);
  }

  if (!confirmed) {
    console.log('\n❌ Cleanup cancelled.');
    process.exit(0);
  }

  // Delete files
  console.log('\n🗑️  Deleting files...');
  const results = deleteFiles(filesToDelete);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 Cleanup Summary');
  console.log('='.repeat(60));
  console.log(`   Folder: ${debugDir}`);
  console.log(`   Files deleted: ${results.deleted}`);
  console.log(`   Files failed: ${results.failed}`);

  if (results.errors.length > 0) {
    console.log(`\n   ❌ Errors:`);
    results.errors.forEach((err) => {
      console.log(`      - ${err.file}: ${err.error}`);
    });
  }

  if (results.deleted > 0) {
    console.log(`\n   ✅ Cleanup completed successfully!`);
  }

  console.log('='.repeat(60) + '\n');

  // Exit with error code if any failures
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run main function
if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };

