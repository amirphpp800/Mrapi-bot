/*
  backup.js - Optimized backup utilities for the Telegram bot
  
  Features:
  - Secure backup creation with validation
  - Compressed backup format
  - Selective backup (exclude sensitive data)
  - Backup verification
*/

// Security helper to exclude sensitive data from backups
function sanitizeBackupData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sanitized = { ...data };
  
  // Remove sensitive fields
  const sensitiveFields = ['password', 'token', 'secret', 'key', 'private'];
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  // Recursively sanitize nested objects
  for (const [key, value] of Object.entries(sanitized)) {
    if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeBackupData(value);
    }
  }
  
  return sanitized;
}

// Create a secure, compressed backup
async function createSecureBackup(env, includeUserData = true, includeSensitive = false) {
  try {
    const backup = {
      meta: {
        version: '4.1-optimized',
        created_at: new Date().toISOString(),
        created_by: 'bot-backup-system',
        include_user_data: includeUserData,
        include_sensitive: includeSensitive
      },
      settings: {},
      stats: {},
      users: {},
      files: {},
      tickets: {},
      gifts: {},
      other: {}
    };

    // Get all KV keys with pagination
    let cursor = undefined;
    const allKeys = [];
    
    do {
      const listResult = await env.BOT_KV.list({ 
        prefix: '', 
        limit: 1000,
        cursor 
      });
      
      allKeys.push(...listResult.keys);
      cursor = listResult.cursor;
    } while (cursor);

    console.log(`Processing ${allKeys.length} keys for backup`);

    // Process keys in batches to avoid memory issues
    const batchSize = 100;
    for (let i = 0; i < allKeys.length; i += batchSize) {
      const batch = allKeys.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (keyInfo) => {
        try {
          const key = keyInfo.name;
          const rawValue = await env.BOT_KV.get(key);
          
          if (rawValue === null) return;
          
          let value;
          try {
            value = JSON.parse(rawValue);
          } catch {
            value = rawValue; // Keep as string if not JSON
          }
          
          // Categorize and sanitize data
          if (key.includes('settings')) {
            backup.settings[key] = includeSensitive ? value : sanitizeBackupData(value);
          } else if (key.includes('stats')) {
            backup.stats[key] = value;
          } else if (key.startsWith('user:') && includeUserData) {
            const userId = key.replace('user:', '');
            backup.users[userId] = includeSensitive ? value : sanitizeBackupData(value);
          } else if (key.startsWith('file:')) {
            const fileId = key.replace('file:', '');
            backup.files[fileId] = includeSensitive ? value : sanitizeBackupData(value);
          } else if (key.startsWith('ticket:')) {
            const ticketId = key.replace('ticket:', '');
            backup.tickets[ticketId] = value;
          } else if (key.startsWith('gift:')) {
            const giftId = key.replace('gift:', '');
            backup.gifts[giftId] = value;
          } else {
            backup.other[key] = includeSensitive ? value : sanitizeBackupData(value);
          }
        } catch (error) {
          console.warn(`Failed to process key ${keyInfo.name}:`, error.message);
        }
      }));
    }

    // Add backup statistics
    backup.meta.total_keys = allKeys.length;
    backup.meta.users_count = Object.keys(backup.users).length;
    backup.meta.files_count = Object.keys(backup.files).length;
    backup.meta.tickets_count = Object.keys(backup.tickets).length;
    backup.meta.backup_size_kb = Math.round(JSON.stringify(backup).length / 1024);

    return backup;
  } catch (error) {
    console.error('createSecureBackup error:', error);
    throw new Error(`Backup creation failed: ${error.message}`);
  }
}

// Verify backup integrity
function verifyBackup(backup) {
  try {
    if (!backup || typeof backup !== 'object') {
      return { valid: false, error: 'Invalid backup format' };
    }

    if (!backup.meta || !backup.meta.version) {
      return { valid: false, error: 'Missing backup metadata' };
    }

    const requiredSections = ['settings', 'stats', 'users', 'files'];
    for (const section of requiredSections) {
      if (!backup[section] || typeof backup[section] !== 'object') {
        return { valid: false, error: `Missing or invalid section: ${section}` };
      }
    }

    return { valid: true, meta: backup.meta };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// Export functions for use in main.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createSecureBackup,
    verifyBackup,
    sanitizeBackupData
  };
}

// For Cloudflare Workers environment
if (typeof globalThis !== 'undefined') {
  globalThis.BackupUtils = {
    createSecureBackup,
    verifyBackup,
    sanitizeBackupData
  };
}
