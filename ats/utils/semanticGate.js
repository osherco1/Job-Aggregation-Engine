const { titlePassesSemanticFilters } = require('../../filters_shared');

function passesSemanticGate(title) {
  return titlePassesSemanticFilters(title);
}

module.exports = {
  passesSemanticGate,
};



