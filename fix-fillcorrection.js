const fs = require('fs');

let content = fs.readFileSync('player.js', 'utf8');

// Remove the PlayerGame.showFillScores(results); line
const toRemove = `      PlayerGame.showFillScores(results);`;
const toAdd = `      setGamePlayersStripVisible(false);`;

if (content.includes(toRemove)) {
  content = content.replace(toRemove, toAdd);
  fs.writeFileSync('player.js', content);
  console.log('✅ Replaced showFillScores with setGamePlayersStripVisible(false)');
} else {
  console.log('❌ Could not find PlayerGame.showFillScores(results);');
}
