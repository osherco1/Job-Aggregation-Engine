require('dotenv').config();
const { MongoClient } = require('mongodb');

async function emergencyPurge() {
  console.log('🚨 Starting Emergency DB Purge...');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('jobbot_db');
    
    console.log('Connected. Nuking calibration_rejected...');
    const rejectedRes = await db.collection('calibration_rejected').deleteMany({});
    console.log(`✅ Deleted ${rejectedRes.deletedCount} records from calibration_rejected.`);

    console.log('Nuking calibration_passed...');
    const passedRes = await db.collection('calibration_passed').deleteMany({});
    console.log(`✅ Deleted ${passedRes.deletedCount} records from calibration_passed.`);

    console.log('Emergency purge complete! DB should be breathing again.');
  } catch (error) {
    console.error('❌ Purge failed:', error);
  } finally {
    await client.close();
    process.exit(0);
  }
}

emergencyPurge();
