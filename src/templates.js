const nunjucks = require('nunjucks');
const path = require('path');
const fs = require('fs');

const customTemplatesDir = path.join(__dirname, '..', 'data', 'templates');
const defaultTemplatesDir = path.join(__dirname, 'templates');

// Ensure custom directory exists
if (!fs.existsSync(customTemplatesDir)) {
  fs.mkdirSync(customTemplatesDir, { recursive: true });
}

const env = nunjucks.configure([customTemplatesDir, defaultTemplatesDir], {
  autoescape: true,
});

const renderTemplate = (templateId, data) => {
  return new Promise((resolve, reject) => {
    // In a real app, you might check if .html exists, and have a .txt fallback
    const htmlTemplate = `${templateId}.html`;
    env.render(htmlTemplate, data, (err, res) => {
      if (err) {
        return reject(err);
      }
      resolve(res);
    });
  });
};

module.exports = {
  renderTemplate,
};
