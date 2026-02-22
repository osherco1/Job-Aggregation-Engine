## סיפורי משתמש (User Stories)

### ניהול רשימת מעקב (Configuration)

**Story:**  
כ־**Developer**, אני רוצה לנהל קובץ קונפיגורציה בשם `companies_list.json` כדי שאוכל להוסיף/להסיר חברות (למשל Monday.com, Lemonade) ללא צורך בשינוי קוד.  

**Details:**  
* הקובץ יכיל מערך של אובייקטים, כאשר כל אובייקט מייצג חברה אחת.  
* לכל חברה יוגדרו:
  * `id` פנימי (מזהה לוגי במערכת).  
  * `name` תצוגה (שם החברה כפי שיופיע בדוחות).  
  * `type` – ערך Enum: `comeet` או `greenhouse`.  
  * `uid` – מזהה חיצוני כפי שנדרש על ידי ה־API של Comeet/Greenhouse (כגון company id / board token).  
* ה־Orchestrator יקרא את הקובץ בתחילת הריצה ויבנה רשימת endpoints בהתאם לסוג החברה.  

### שליפת משרות (Fetching)

**Story:**  
כ־**System**, אני רוצה לשלוף **את כל המשרות הפתוחות** מ־API ה־ATS של כל חברה בקובץ `companies_list.json`, כדי להבטיח **Zero False Negatives** ברמת החברה (לא לפספס משרות רלוונטיות שקיימות ב־ATS).  

**Details:**  
* עבור כל חברה:
  * אם `type = comeet` – קריאה ל־Comeet Endpoint המתאים (למשל רשימת positions פעילים).  
  * אם `type = greenhouse` – קריאה ל־Greenhouse Endpoint (למשל רשימת jobs פתוחים).  
* המערכת תבצע לולאה על כל החברות ותשלוף את כל ה־open positions בלי הגבלה מלמעלה (מלבד הגבלות API אם קיימות).  
* כל תוצאה תעבור נרמול (Normalization) למודל אחיד לפני החלת פילטרים.  

### סינון מיקום (Location Gate)

**Story:**  
כ־**System**, אני רוצה להחיל **Location Gate** שמפיל כל משרה שהמיקום שלה אינו רלוונטי לשוק היעד (ישראל), כדי לחסוך רעש מיותר לרמת הפילטרים הסמנטיים.  

**Rules (דוגמה):**  
* **Keep** – אם מחרוזת המיקום (`location.name` או שדה מקביל) מכילה אחד מהערכים/דפוסים הבאים:
  * `"Israel"`, `"Tel Aviv"`, `"Herzliya"`, `"Ramat Gan"`, `"Gush Dan"`, `"Center District"`.  
  * `"Remote"` כאשר ידוע שהחברה פתוחה ל־Remote מישראל.  
* **Drop** – אם המיקום הוא:
  * `"New York"`, `"London"`, `"Berlin"` או כל עיר מחוץ לישראל.  
  * אזור גאוגרפי לא מזוהה כמתאים (למשל `"EMEA"` ללא ציון Israel).  

### סינון סמנטי (Semantic Filtering)

**Story:**  
כ־**System**, אני רוצה להחיל פילטר סמנטי על כותרת המשרה (`title`) כך שמשרות Senior/Manager ותפקידי Non-Tech ייפלו, ורק משרות מתאימות ל־Junior/Student/Developer יישארו.  

**Rules (High Level):**  
* **Blacklist (Drop):**
  * כותרות שמכילות:
    * "Senior", "Lead", "Manager", "Head of", "Director".  
    * תפקידים כמו "HR", "Recruiter", "Office Manager" וכו'.  
* **Whitelist (Keep Gate):**
  * כותרות שמכילות:
    * "Student", "Intern", "Junior", "Graduate", "Entry Level".  
    * או מילים טכנולוגיות כמו "Developer", "Engineer", "Software", "Data", "QA".  
* **Logic:**
  * אם כותרת מכילה ביטוי Blacklist → Drop.  
  * אחרת, אם הכותרת **לא** מכילה אף ביטוי Whitelist → Drop.  
  * רק משרות שעוברות את שני השלבים נשמרות לצורך המשך עיבוד (Enrichment/Email/Reports).  


