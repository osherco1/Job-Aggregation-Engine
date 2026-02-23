/**
 * Migration Script: Local Files → MongoDB Atlas
 * 
 * One-off script to seed MongoDB collections with data from local files.
 * This preserves bot memory (seen jobs, sent history) and company configurations.
 * 
 * Usage: node tools/migrate_to_mongo.js
 * 
 * Requirements:
 * - MONGODB_URI must be set in .env file
 * - Local data files must exist in data/ directory
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Collection names (must match MongoStorageAdapter)
const COLLECTIONS = {
  SEEN_JOBS: 'seen_jobs',
  ATS_SENT_HISTORY: 'ats_sent_history',
  COMPANIES: 'companies',
};

// Database name (extracted from URI or default)
function extractDbName(uri) {
  try {
    const url = new URL(uri);
    const pathname = url.pathname;
    if (pathname && pathname.length > 1) {
      return pathname.substring(1);
    }
    return 'jobbot_db';
  } catch (err) {
    return 'jobbot_db';
  }
}

/**
 * Load and parse a JSON file
 */
function loadJsonFile(filePath, errorContext = 'required') {
  try {
    if (!fs.existsSync(filePath)) {
      if (errorContext === 'optional') {
        return [];
      }
      throw new Error(`File not found: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error(`${path.basename(filePath)} must contain an array`);
    }

    return parsed;
  } catch (err) {
    if (errorContext === 'optional') {
      console.warn(`Warning: Failed to load ${path.basename(filePath)}: ${err.message}`);
      return [];
    }
    throw new Error(
      `Failed to read ${path.basename(filePath)} at ${filePath}: ${err.message || err}`
    );
  }
}

/**
 * Load and parse greenhouse_list.csv
 */
function loadGreenhouseCsv() {
  const filePath = path.join(DATA_DIR, 'greenhouse_list.csv');

  if (!fs.existsSync(filePath)) {
    console.warn('Warning: greenhouse_list.csv not found, skipping');
    return [];
  }

  return new Promise((resolve, reject) => {
    const companies = [];
    const stream = fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => {
        const { id, name, uid } = row;
        if (id && uid) {
          companies.push({
            id: String(id).trim(),
            name: (name || id).trim(),
            type: 'greenhouse',
            uid: String(uid).trim(),
            token: null,
            enabled: true,
          });
        }
      })
      .on('end', () => {
        resolve(companies);
      })
      .on('error', (err) => {
        console.warn(`Warning: Failed to parse greenhouse_list.csv: ${err.message}`);
        resolve([]);
      });
  });
}

/**
 * Normalize a company entry to standard format
 */
function normalizeCompany(entry) {
  return {
    id: String(entry.id || '').trim(),
    name: String(entry.name || '').trim(),
    type: entry.type === 'greenhouse' ? 'greenhouse' : (entry.type === 'workday' ? 'workday' : 'comeet'),
    uid: String(entry.uid || '').trim(),
    token: entry.token ? String(entry.token).trim() : undefined,
    apiBaseUrl: entry.apiBaseUrl ? String(entry.apiBaseUrl).trim() : undefined,
    url: entry.url ? String(entry.url).trim() : undefined,
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
  };
}

/**
 * Load and merge all company configuration files
 */
async function loadAllCompanies() {
  const COMPANIES_FILE = path.join(DATA_DIR, 'companies_list.json');
  const COMEET_COMPANIES_FILE = path.join(DATA_DIR, 'comeet_companies_auto.json');
  const WORKDAY_COMPANIES_FILE = path.join(DATA_DIR, 'workday_companies.json');

  // Load all sources
  const [mainCompanies, comeetCompanies, greenhouseCompanies, workdayCompanies] = await Promise.all([
    Promise.resolve(loadJsonFile(COMPANIES_FILE, 'required')),
    Promise.resolve(loadJsonFile(COMEET_COMPANIES_FILE, 'optional')),
    loadGreenhouseCsv(),
    Promise.resolve(loadJsonFile(WORKDAY_COMPANIES_FILE, 'optional')),
  ]);

  // Normalize workday companies (they have { id, name, url } structure)
  const normalizedWorkday = (workdayCompanies || []).map(entry => ({
    id: String(entry.id || '').trim(),
    name: String(entry.name || '').trim(),
    type: 'workday',
    uid: String(entry.url || '').trim(), // Workday uses url as uid
    url: String(entry.url || '').trim(),
    enabled: true,
  }));

  // Normalize all companies
  const allCompanies = [
    ...mainCompanies,
    ...comeetCompanies,
    ...greenhouseCompanies,
    ...normalizedWorkday,
  ]
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => normalizeCompany(entry))
    .filter((entry) => entry.id && entry.name && entry.uid && entry.enabled);

  // Remove duplicates by id (prefer main list over comeet list if both exist)
  const companyMap = new Map();
  for (const company of allCompanies) {
    if (!companyMap.has(company.id)) {
      companyMap.set(company.id, company);
    }
  }

  return Array.from(companyMap.values());
}

/**
 * Seed seen_jobs collection
 */
async function seedSeenJobs(collection) {
  const filePath = path.join(DATA_DIR, 'seen_jobs.json');

  if (!fs.existsSync(filePath)) {
    console.log('  ⚠️  seen_jobs.json not found, skipping...');
    return 0;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const jobIds = JSON.parse(raw);

    if (!Array.isArray(jobIds)) {
      console.log('  ⚠️  seen_jobs.json is not an array, skipping...');
      return 0;
    }

    if (jobIds.length === 0) {
      console.log('  ℹ️  No seen jobs to migrate');
      return 0;
    }

    const now = new Date();
    const operations = jobIds.map(jobId => ({
      updateOne: {
        filter: { _id: String(jobId) },
        update: {
          $set: {
            _id: String(jobId),
            source: 'linkedin',
            migratedAt: now,
          },
          $setOnInsert: {
            firstSeenAt: now,
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await collection.bulkWrite(operations, { ordered: false });
    return result.upsertedCount + result.modifiedCount;
  } catch (err) {
    console.error(`  ❌ Error seeding seen_jobs: ${err.message}`);
    throw err;
  }
}

/**
 * Seed ats_sent_history collection
 */
async function seedAtsSentHistory(collection) {
  const filePath = path.join(DATA_DIR, 'ats_sent_jobs_history.json');

  if (!fs.existsSync(filePath)) {
    console.log('  ⚠️  ats_sent_jobs_history.json not found, skipping...');
    return 0;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (!data || !Array.isArray(data.sentJobIds)) {
      console.log('  ⚠️  ats_sent_jobs_history.json has invalid format, skipping...');
      return 0;
    }

    const jobIds = data.sentJobIds;

    if (jobIds.length === 0) {
      console.log('  ℹ️  No sent job IDs to migrate');
      return 0;
    }

    const now = new Date();
    const operations = jobIds.map(jobId => ({
      updateOne: {
        filter: { _id: String(jobId) },
        update: {
          $set: {
            _id: String(jobId),
            source: 'ats',
            migratedAt: now,
          },
          $setOnInsert: {
            sentAt: now,
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await collection.bulkWrite(operations, { ordered: false });
    return result.upsertedCount + result.modifiedCount;
  } catch (err) {
    console.error(`  ❌ Error seeding ats_sent_history: ${err.message}`);
    throw err;
  }
}

/**
 * Seed companies collection
 */
async function seedCompanies(collection) {
  try {
    const companies = await loadAllCompanies();

    if (companies.length === 0) {
      console.log('  ⚠️  No companies to migrate');
      return 0;
    }

    const now = new Date();
    const operations = companies.map(company => ({
      updateOne: {
        filter: { _id: company.id },
        update: {
          $set: {
            _id: company.id,
            name: company.name,
            type: company.type,
            uid: company.uid,
            token: company.token,
            apiBaseUrl: company.apiBaseUrl,
            url: company.url,
            enabled: company.enabled,
            migratedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        upsert: true,
      },
    }));

    const result = await collection.bulkWrite(operations, { ordered: false });
    return result.upsertedCount + result.modifiedCount;
  } catch (err) {
    console.error(`  ❌ Error seeding companies: ${err.message}`);
    throw err;
  }
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('\n' + '='.repeat(60));
  console.log('🔄 MongoDB Migration Script');
  console.log('='.repeat(60));

  // Check for MONGODB_URI
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌ Error: MONGODB_URI not found in environment variables');
    console.error('   Please set MONGODB_URI in your .env file');
    process.exit(1);
  }

  const dbName = extractDbName(mongoUri);
  console.log(`📦 Database: ${dbName}`);
  console.log(`🔗 Connecting to MongoDB...`);

  let client;
  try {
    // Connect to MongoDB
    client = new MongoClient(mongoUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });

    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db(dbName);

    // Seed seen_jobs
    console.log('📝 Seeding seen_jobs collection...');
    const seenJobsCollection = db.collection(COLLECTIONS.SEEN_JOBS);
    const seenJobsCount = await seedSeenJobs(seenJobsCollection);
    console.log(`   ✅ Migrated ${seenJobsCount} seen job IDs\n`);

    // Seed ats_sent_history
    console.log('📝 Seeding ats_sent_history collection...');
    const atsHistoryCollection = db.collection(COLLECTIONS.ATS_SENT_HISTORY);
    const atsHistoryCount = await seedAtsSentHistory(atsHistoryCollection);
    console.log(`   ✅ Migrated ${atsHistoryCount} sent job IDs\n`);

    // Seed companies
    console.log('📝 Seeding companies collection...');
    const companiesCollection = db.collection(COLLECTIONS.COMPANIES);
    const companiesCount = await seedCompanies(companiesCollection);
    console.log(`   ✅ Migrated ${companiesCount} companies\n`);

    // Summary
    console.log('='.repeat(60));
    console.log('✅ Migration Complete!');
    console.log('='.repeat(60));
    console.log(`   seen_jobs: ${seenJobsCount} records`);
    console.log(`   ats_sent_history: ${atsHistoryCount} records`);
    console.log(`   companies: ${companiesCount} records`);
    console.log('='.repeat(60) + '\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message || err);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('🔌 MongoDB connection closed\n');
    }
  }

  process.exit(0);
}

// Run migration
if (require.main === module) {
  migrate().catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { migrate };

