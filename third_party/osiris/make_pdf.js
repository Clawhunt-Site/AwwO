
const markdownpdf = require('markdown-pdf');
markdownpdf().from('OSIRIS_Master_Operations_Manual.md').to('C:\\Users\\mrads\\Downloads\\OSIRIS_Master_Operations_Manual.pdf', function () {
  console.log('Done');
});

