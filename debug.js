const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');
const lines = content.split('\n');

// Find lines that contain showScreen
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("showScreen('screen-podium')")) {
    console.log(`Line ${i}: ${lines[i]}`);
    console.log(`Previous: ${lines[i-1]}`);
    console.log(`Previous-2: ${lines[i-2]}`);
    console.log('---');
  }
}

// Also check for statEl.style.display
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('statEl.style.display')) {
    console.log(`statEl.style line ${i}: ${lines[i]}`);
    console.log(`Next: ${lines[i+1]}`);
    console.log(`Next-2: ${lines[i+2]}`);
    console.log('---');
  }
}
