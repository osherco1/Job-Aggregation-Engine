/**
 * Storage Adapter Factory
 * 
 * Selects the appropriate storage adapter based on environment configuration.
 * - If STORAGE_BACKEND=mongo or MONGODB_URI is set, returns MongoStorageAdapter
 * - Otherwise, returns FileStorageAdapter (local dev)
 */

const { FileStorageAdapter } = require('./FileStorageAdapter');

/**
 * Create a storage adapter instance
 * @returns {StorageAdapter}
 */
function createStorageAdapter() {
  // Check for explicit storage backend setting or MongoDB URI
  const storageBackend = process.env.STORAGE_BACKEND;
  const hasMongoUri = !!process.env.MONGODB_URI;
  
  if (storageBackend === 'mongo' || hasMongoUri) {
    if (!process.env.MONGODB_URI) {
      throw new Error('STORAGE_BACKEND=mongo requires MONGODB_URI environment variable');
    }
    
    const { MongoStorageAdapter } = require('./MongoStorageAdapter');
    return new MongoStorageAdapter(process.env.MONGODB_URI);
  }

  // Default: file-based storage (local dev)
  return new FileStorageAdapter();
}

module.exports = {
  createStorageAdapter,
  FileStorageAdapter,
  MongoStorageAdapter: require('./MongoStorageAdapter').MongoStorageAdapter,
};

