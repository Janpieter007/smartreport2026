const { google } = require('googleapis');

(async () => {
  try {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) {
      throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to the service account JSON path before running.');
    }

    const auth = new google.auth.GoogleAuth({
      keyFilename: keyPath,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const client = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: client });

    const res = await drive.files.list({
      pageSize: 10,
      fields: 'files(id, name, mimeType)'
    });

    console.log('Drive files visible to the service account:');
    console.log(JSON.stringify(res.data.files || [], null, 2));
  } catch (err) {
    console.error('Drive test failed:');
    console.error(err && err.response ? err.response.data || err.message : err.message || err);
    process.exitCode = 2;
  }
})();
