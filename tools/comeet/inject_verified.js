const fs = require('fs');
const path = './data/comeet_companies_auto.json';

try {
    let companies = JSON.parse(fs.readFileSync(path, 'utf8'));
    
    // רשימת החברות המאומתות
    const verified = [
        { id: 'jeenai', name: 'Jeen.ai', uid: 'DA.008' },
        { id: 'landacorp', name: 'Landa Corporation', uid: 'A4.000' },
        { id: 'landalabs', name: 'Landa Labs', uid: 'B2.00D' }
    ];

    verified.forEach(newComp => {
        // מחיקת ישן
        companies = companies.filter(c => c.uid !== newComp.uid);
        // הוספת חדש
        companies.push(newComp);
        console.log('✅ Added/Updated: ' + newComp.name + ' (Slug: ' + newComp.id + ')');
    });

    fs.writeFileSync(path, JSON.stringify(companies, null, 2));
    console.log('💾 Database saved successfully.');

} catch (err) {
    console.error('❌ Error:', err.message);
}