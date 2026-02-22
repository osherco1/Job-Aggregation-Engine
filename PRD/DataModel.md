## מודל נתונים (Data Model)

### מבנה הקונפיגורציה (Configuration Schema)

קובץ `companies_list.json` מגדיר את רשימת החברות שמהן המערכת תשלוף משרות באמצעות ATS (Comeet/Greenhouse).  
הקובץ מכיל מערך של אובייקטים, כאשר כל אובייקט מייצג חברה אחת לפי הסכמה הבאה:

```json
[
  {
    "id": "monday",
    "name": "Monday.com",
    "type": "comeet",
    "uid": "monday-prod"
  },
  {
    "id": "lemonade",
    "name": "Lemonade",
    "type": "greenhouse",
    "uid": "lemonade"
  }
]
```

**שדות:**

* `id` – מזהה לוגי פנימי במערכת (ישן לשימוש ב־logs, filters, feature flags).  
* `name` – שם החברה לתצוגה בדוחות, מיילים וממשקי ניהול.  
* `type` – סוג האינטגרציה:
  * `"comeet"` – שימוש ב־Comeet Adapter.  
  * `"greenhouse"` – שימוש ב־Greenhouse Adapter.  
* `uid` – מזהה חיצוני כפי שנדרש על ידי ה־API של ה־ATS:
  * עבור Comeet – יכול להיות `company_uid` או מזהה Organization כפי שמתועד ב־API.  
  * עבור Greenhouse – יכול להיות `board_token` או מזהה Company המשמש לבניית ה־Endpoint.  

### מיפוי נרמול (Normalization Mapping)

מטרת שכבת ה־Normalization היא למפות את ה־JSON הגולמי מכל ATS אל **Unified Job Model** משותף, כך שכל שאר רכיבי המערכת (Filters, Storage, Mailer) יעבדו מול שדות אחידים.  

טבלת המיפוי הבאה מסכמת את ההתאמה בין השדות המרכזיים:

| Field        | Comeet Source         | Greenhouse Source |
| ------------ | --------------------- | ------------------|
| `jobId`      | `uid` (עם prefix אם צריך, לדוגמה: `"comeet_" + uid`) | `id` (עם prefix אם צריך, לדוגמה: `"gh_" + id`) |
| `title`      | `name`                | `title`           |
| `location`   | `location.name`       | `location.name`   |
| `url`        | `url_active_page`     | `absolute_url`    |
| `description`| `description`         | `content`         |

**הערות יישום:**

* מומלץ להוסיף prefix ל־`jobId` לפי מקור (`comeet_`, `gh_`) כדי למנוע התנגשות IDs בין מערכות שונות.  
* בשדות `location` ו־`description` יש להחיל נורמליזציה (trim, החלפת `\r\n` ב־`\n`, וכדומה) לפני המשך עיבוד.  
* אם אחד השדות (למשל `description`) חסר במקור, יש להחזיר `null` ולא מחרוזת ריקה כדי לשמור על עקביות במודל האחיד.  


