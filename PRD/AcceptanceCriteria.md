## קריטריוני קבלה (Acceptance Criteria)

### ביצועים (Performance)

* **זמן ריצה כולל**  
  * הרצת הלולאה המלאה על **50 חברות** (Comeet/Greenhouse ביחד) חייבת להסתיים בתוך **120 שניות** בסביבת Production טיפוסית.  
* **Delays בין בקשות**  
  * יש ליישם השהייה אקראית (Random Delay) בין קריאות HTTP:
    * טווח: **200ms–500ms** בין כל בקשה ל־ATS (Per Request).  
  * המטרה:
    * לצמצם סיכון ל־Rate Limiting או חסימה על ידי ה־ATS.  
    * לשמר פרופיל תעבורה "אנושי" ולא רבוד מדי.  

### טיפול בשגיאות (Error Handling)

* **עמידות ברמת חברה (Company-Level Resilience)**  
  * אם קריאה ל־API של חברה ספציפית מחזירה קוד **404** או **500**:
    * המערכת תרשום **WARN** ברור ב־logs (כולל `company id`, כתובת `endpoint`, וקוד השגיאה).  
    * ה־Orchestrator **ימשיך לחברה הבאה** ללא קריסה של התהליך הראשי.  
* **איסור Crash עקב ATS יחיד**  
  * תקלות זמניות (network error, timeout, 5xx) באחת החברות:
    * אינן גורמות ליציאה עם כשל כללי של הסקריפט.  
    * נספרות בסטטיסטיקות שגיאה, אך אינן עוצרות את הלולאה הכוללת.  

### בדיקות לוגיות (Logic Tests)

#### Verify Location (Location Gate)

* **קלט:** משרה עם `location = "New York"`  
  * **תוצאה צפויה:** Drop (המשרה מסוננת בשלב Location Gate).  
* **קלט:** משרה עם `location = "Tel Aviv"`  
  * **תוצאה צפויה:** Keep (המשרה עוברת לשלב הפילטרים הסמנטיים).  

#### Verify Blacklist (Semantic Blacklist)

* **קלט:** `title = "Senior Java Dev"`  
  * **תוצאה צפויה:** Drop  
  * סיבה: הכותרת מכילה מילה מרשימת Blacklist ("Senior") ולכן המשרה נפסלת אוטומטית.  

#### Verify Whitelist (Semantic Whitelist)

* **קלט:** `title = "Junior HR"`  
  * **תוצאה צפויה:** Drop  
  * סיבה: למרות שקיים "Junior", אין מילות מפתח טכנולוגיות (Developer/Engineer/Software/Data וכו'), ולכן המשרה נחשבת Non-Tech.  

* **קלט:** `title = "Junior Developer"`  
  * **תוצאה צפויה:** Keep  
  * סיבה: הכותרת מכילה גם "Junior" וגם "Developer", ולכן עומדת גם בתנאי ה־Whitelist וגם אינה עוברת על Blacklist.  


