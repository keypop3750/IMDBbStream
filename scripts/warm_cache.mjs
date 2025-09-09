#!/usr/bin/env node
// scripts/warm_cache.mjs
// Pre-processes all user lists to create fast cache files

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { warmList } from '../lib/prefetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function main() {
  console.log('🔥 Warming cache for all user lists...\n');
  
  const users = loadUsers();
  
  for (const [uid, userData] of Object.entries(users)) {
    if (!userData.lists || !Array.isArray(userData.lists)) continue;
    
    console.log(`👤 Processing user: ${uid}`);
    
    for (const list of userData.lists) {
      const lsid = list.id || list.lsid || list;
      const name = list.name || `List ${lsid}`;
      
      try {
        console.log(`  📋 Warming ${name} (${lsid})...`);
        const result = await warmList(uid, lsid, {
          origin: process.env.PUBLIC_BASE || 'http://localhost:7000'
        });
        
        if (result.ok) {
          console.log(`    ✅ Success: ${result.counts.movies} movies, ${result.counts.series} series`);
        } else {
          console.log(`    ❌ Failed`);
        }
      } catch (error) {
        console.log(`    ❌ Error: ${error.message}`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log();
  }
  
  console.log('🎉 Cache warming complete!');
}

main().catch(console.error);
