const fs = require('fs');
const path = require('path');

// Read the player.js file
let content = fs.readFileSync('player.js', 'utf8');

// Verify content contains what we're looking for
if (!content.includes('PlayerGame.showFillScores(results);')) {
  console.log('ERROR: Could not find showFillScores call');
  process.exit(1);
}

// Remove the PlayerGame.showFillScores(results); line and replace with setGamePlayersStripVisible
content = content.replace(
  `sse.addEventListener('fillCorrectionEnd', function(e) {
      const data = JSON.parse(e.data || '{}');
      const results = Array.isArray(data.results) ? data.results : [];
      PlayerGame.showFillScores(results);`,
  `sse.addEventListener('fillCorrectionEnd', function(e) {
      setGamePlayersStripVisible(false);
      const data = JSON.parse(e.data || '{}');
      const results = Array.isArray(data.results) ? data.results : [];`
);

// Update the showPodium function to simplify stats display and add 30-second timer
// Find and replace the stats block
const oldStatsBlock = `      statEl.innerHTML =
        '<div class="pps-main" style="color:' + pctColor + '">' + pct + '%</div>' +
        '<div class="pps-sub">de bonnes reponses</div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">🎯</span>' +
          '<span class="pps-label">Bonnes réponses</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + ' — ' + pct + '%</span>' +
        '</div>' +
        '<div class="pps-bar-wrap"><div class="pps-bar" style="width:' + pct + '%;background:' + pctColor + '"></div></div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement</span>' +
          '<span class="pps-value">' + rank + 'e&nbsp;/ ' + sorted.length + '</span>' +
        '</div>' +
        '<div class="pps-message" style="border-color:' + pctColor + '">' + encouragement + '</div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">💯</span>' +
          '<span class="pps-label">Score total</span>' +
          '<span class="pps-value">' + (me.score || 0) + ' pts</span>' +
        '</div>';`;

const newStatsBlock = `      statEl.innerHTML =
        '<div class="pps-main" style="color:' + pctColor + '">' + pct + '%</div>' +
        '<div class="pps-sub">de bonnes reponses</div>' +
        '<div class="pps-bar-wrap"><div class="pps-bar" style="width:' + pct + '%;background:' + pctColor + '"></div></div>' +
        '<div class="pps-row">' +
          '<span class="pps-icon">' + rankEmoji + '</span>' +
          '<span class="pps-label">Classement ' + rank + 'e/' + sorted.length + '</span>' +
          '<span class="pps-value" style="color:' + pctColor + '">' + correct + '/' + total + '</span>' +
        '</div>' +
        '<div class="pps-message" style="border-color:' + pctColor + '">' + encouragement + '</div>';`;

if (content.includes(oldStatsBlock)) {
  content = content.replace(oldStatsBlock, newStatsBlock);
  console.log('✓ Updated stats display to simplified version');
} else {
  console.log('⚠ Could not find exact stats block to replace (may have changed)');
}

// Add 30-second timer to showPodium
const oldShowScreen = `    showScreen('screen-podium');
  }

  function showFillScores(results) {`;

const newShowScreen = `    showScreen('screen-podium');
    
    // Auto-transition après 30 secondes si final
    if (isFinal) {
      if (window.podiumTimeout) clearTimeout(window.podiumTimeout);
      window.podiumTimeout = setTimeout(() => {
        const currentScreen = getActiveScreenId();
        if (currentScreen === 'screen-podium') {
          returnToJoinScreen();
        }
      }, 30000);
    }
  }

  function showFillScores(results) {`;

if (content.includes(oldShowScreen)) {
  content = content.replace(oldShowScreen, newShowScreen);
  console.log('✓ Added 30-second auto-transition timer');
} else {
  console.log('⚠ Could not find showScreen call to add timer');
}

// Write the updated content
fs.writeFileSync('player.js', content);
console.log('\n✓ Changes applied to player.js');
