## מסמך אפיון ראשי - אינטגרציית ATS (שלב 5)

### תקציר מנהלים (Executive Summary)

מערכת LinkedIn Job Bot הקיימת פועלת כיום כ־**Voyager Scraper** המתמקד ב־LinkedIn בלבד, עם פילטרים מתקדמים לזיהוי משרות Junior/Student.  
בשלב 5 אנו מרחיבים את המערכת למודל **Hub & Spoke**:  
- **Hub** – Orchestrator מרכזי שמנהל את ה־Matrix, ה־Filters והזרימה הלוגית.  
- **Spokes** – אינטגרציות ATS ישירות אל **Comeet** ו־**Greenhouse**, המאפשרות שליפה ישירה מ־API רשמי של החברות.  

המעבר למודל זה נועד:  
* לשפר **Data Quality** (פחות רעש, יותר שדות מובנים).  
* להפחית **תלות ב־LinkedIn Voyager API** ובשינויים בממשק הלא־רשמי.  
* לאפשר סקיילינג עתידי לאינטגרציות נוספות (ATS נוספים, קריירסייטים וכו').  

### מטרות (Objectives)

1. **Source Diversification**  
   * הוספת ערוץ ATS רשמי (Comeet & Greenhouse) בנוסף ל־Voyager, כך שהמערכת לא תלויה רק במקור יחיד.  

2. **Data Integrity**  
   * שמירה על מודל נתונים אחיד (Unified Job Model) עם שדות כמו `jobId`, `title`, `location`, `url`, `description` המנורמלים מכל מקור.  

3. **Market Coverage (~75%)**  
   * הגעה לכיסוי של כ־75% משוק הסטארטאפים/חברות טכנולוגיה הרלוונטיות לישראל באמצעות רשימת חברות מנוהלת (`companies_list.json`) ו־endpoints של ATS.  

4. **Precision Filtering**  
   * המשך מיקוד ב־Junior/Student/Entry Level תוך שמירה על **0% False Positives** מחוץ לדומיין Israel Tech (כולל מניעת תפקידי Hardware/Legal/Operations).  

### ארכיטקטורת מערכת (System Architecture)

בשלב 5 הארכיטקטורה עוברת למודל **Hub & Spoke**:

* **Orchestrator (Hub)**  
  * מודול מרכזי (ב־Node.js) שאחראי על:
    * קריאת `companies_list.json` והפקת רשימת endpoints לכל ATS.  
    * הרצת לולאת Fetch עבור כל חברה (Company) ומקור (Comeet/Greenhouse).  
    * החלת לוגיקת פילטרים (Location Gate + Semantic Filtering) ברמת Unified Job Model.  
    * כתיבת התוצאות לקבצי JSON ולזרימות המשך (Mailer, Analyze).  

* **Config Provider**  
  * שכבת קונפיגורציה אחודה המספקת:
    * גישה ל־`companies_list.json`.  
    * Wires של credentials/keys עבור כל ATS (אם נדרש).  
    * פרמטרים גלובליים (Delays, Limits, Feature Flags).  

* **Adapters (Spokes)**  
  * **Comeet Adapter**  
    * יודע לקרוא Endpoint של Comeet (לדוגמה: `/api/v2/positions`), לשלוף את כל ה־open positions, ולהמיר אותן ל־Unified Job Model.  
  * **Greenhouse Adapter**  
    * יודע לקרוא Endpoint של Greenhouse (לדוגמה: `/v1/boards/{company}/jobs`), לנרמל את ה־JSON המתקבל ולהתאים לשדות המודל האחיד.  
  * שני ה־Adapters חולקים חוזה משותף (Interface לוגי) כך שה־Orchestrator יכול לעבוד בצורה זהה מול שני המערכות.  

* **Existing LinkedIn Voyager Leg**  
  * ממשיך לפעול כ־Spoke נוסף (חיצוני) כך שהמערכת יכולה לשלב בין משרות מ־Voyager לבין משרות מ־ATS, תוך שימוש באותם Filters ו־Analytics.  

### מדדי הצלחה (KPIs)

* **Yield – תפוקה**  
  * ממוצע של **5+ משרות Junior/Student חדשות בשבוע** מתוך אינטגרציות ATS בלבד (לא כולל Voyager).  

* **Precision – דיוק**  
  * **100% Israel Tech**:
    * כל משרה שעוברת את הפילטר חייבת להיות:
      * מיקום רלוונטי (Israel / Tel Aviv / Herzliya / Remote לישראל).  
      * תפקיד תוכנה/טכנולוגיה (לא Hardware/Legal/Operations).  
  * 0 משרות עם כותרות כמו "Mechanical Engineer", "Electrical Engineer", "Legal Counsel" וכו'.  

* **Robustness – יציבות**  
  * הרצת לולאה מלאה על 50+ חברות ללא קריסת תהליך, גם במקרה של 404/500 מצד ATS בודד (ה־Orchestrator מדלג וממשיך).  


