# Najiz filing steps (Phase 5)

How a promissory note is filed for execution on Najiz Business, written from
Sal's screen recordings (10 November 2026). This is the map for the filing
robot (5.4) and the status checks (5.5). It holds no real names, ID numbers or
bank details. Najiz labels are kept in Arabic, as they appear on the site.

If any page looks different from this, the robot stops and tells the client's
staff (Najiz rule 6 in CLAUDE.md). When Najiz changes, update this file first.

## Where each value comes from

| Najiz asks for | Taken from |
|---|---|
| Owner's national ID or iqama number (sign-in) | `clients.owner_id_number` |
| Unified establishment number (starts with 7) | `clients.unified_number` |
| Representation type | `clients.najiz_representation` (always "ممثل نظامي") |
| Commercial registration, establishment contract, partners' decisions (PDF, at most 0.95 MB each) | `documents` of type `cr`, `establishment_contract`, `partners_decision` |
| Contact email and mobile | Owner's, confirmed by the client at approval: `legal_cases.contact_email`, `contact_phone` |
| Bank and IBAN | `clients.bank_name`, `clients.iban` |
| Debtor nationality, ID type, ID number | `debtors.nationality`, `id_type`, `id_number` |
| Debtor first, father, grandfather, family name | `debtors.first_name`, `father_name`, `grandfather_name`, `family_name` |
| Debtor mobile (optional) | primary `debtor_phones` |
| Amount written in the note | `instruments.face_amount` |
| Amount received, remaining amount | `legal_cases.amount_received`, `legal_cases.amount_claimed` |
| Note number (optional), date written, due date or on demand | `instruments.reference_number`, `issue_date`, `due_date`, `due_on_demand` |
| Place written (country, city) and place of payment | `instruments.issue_country`, `issue_city` (the same place for both) |
| Copy of the note (PDF) | `documents` of type `promissory_note` |
| Court | always "محكمة التنفيذ" |
| Result: request number, circuit, status | `legal_cases.najiz_request_number`, `najiz_circuit`, `najiz_status`; history in `legal_case_events` |

## A. Sign in

1. najiz.sa, choose "أعمال" (Business).
2. "تسجيل الدخول عبر النفاذ الوطني": type the owner's ID number, press "تسجيل الدخول".
3. Najiz shows a two-digit number ("رقم الطلب") and asks to open the Nafath app
   and choose it. The product shows this number to the client and sends it to
   the owner by WhatsApp. The owner chooses it in Nafath.
4. "الحسابات المفعلة" lists the establishments the owner can act for (name and
   unified number). Choose the one whose unified number matches the client.

## B. New execution request

From the dashboard: "التنفيذ", then "طلب جديد", then "تقديم طلب تنفيذ إلكتروني"
(not the virtual court option). Five steps: 1 نوع الطلب, 2 طالب التنفيذ,
3 المنفذ ضده, 4 مضمون الطلب, 5 مراجعة الطلب. Each step has "حفظ كمسودة".

1. **Request type.** Instrument "سند لأمر" (quick pick). Category "تنفيذ مالي",
   main type "أوراق تجارية", sub type "سند لأمر". Requester capacity
   "بالنيابة عن جهة اعتبارية". Tick the pledge that all data and documents are
   correct (the client agrees to the same words when approving).
2. **Requester.** Entity type: company registered with the Ministry of Commerce.
   Unified number, then "تحقق" (Najiz fills the company name). Representation
   type "ممثل نظامي". Upload the commercial registration (required), the
   establishment contract and partners' decisions (optional). Contact: country,
   email, mobile. Bank and IBAN, then "تحقق" (the IBAN must belong to the company).
3. **Debtor.** Nationality, ID type, ID number, first name, father's name
   (optional), grandfather's name (optional), family name, email (optional),
   mobile (optional), work address known or not.
4. **Request content.** Amount in the note, remaining amount (riyals and
   halalas), "received part of the amount?" yes or no, "execute the full
   remaining amount?" yes, currency Saudi riyal. Note number (optional), date
   written, place written (country, city), place of payment, due status (due
   date or on demand), due date. Attach the note copy (required); protest paper
   and translation are optional.
5. **Review.** Check every value against the product's data. Court
   "محكمة التنفيذ". Then "حفظ وإرسال".

Result: "تم تقديم الطلب بنجاح" with the request number. Save the number and a
screenshot of this page (document type `najiz_receipt`).

## C. Status and services after filing

From "التنفيذ", search the list by request number and open the request. It shows
the capacity, types, court, circuit (for example "دائرة التنفيذ الثالثة"), date
submitted (Hijri), request status (for example "قيد التنفيذ") and the amounts
(written, received, remaining, to execute). Najiz notes that the request status
does not show payments; those are in the digital wallet (المحفظة الرقمية).

Services on a request (5.6): "إنهاء السند التنفيذي" (end the instrument, for
example when the debtor paid), "إمهال - تأجيل", "تحويل مبلغ محجوز",
"تعديل مبلغ المطالبة", "خدمات التظلم", add or remove an agent, other services.

## The robot (5.4)

`api/src/najiz/robot.ts` follows sections A and B above. Every Arabic word it
looks for is in `WORDS` at the top of that file.

- Taken from the recordings: the menu and button words (أعمال, تسجيل الدخول عبر
  النفاذ الوطني, الحسابات المفعلة, التنفيذ, طلب جديد, تقديم طلب تنفيذ إلكتروني,
  the five step names, تحقق, حفظ وإرسال, تم تقديم الطلب بنجاح) and the values chosen
  (تنفيذ مالي, أوراق تجارية, سند لأمر, بالنيابة عن جهة اعتبارية, ممثل نظامي, محكمة التنفيذ).
- To confirm on the first real filing (5.4b): the exact label of each field
  (for example whether the amount fields are labelled "(ريال)" and "(هللة)"),
  the yes or no questions, the date format Najiz takes, and how the Nafath
  number is shown. If a word is wrong, the robot stops before sending and says
  which word it could not find; change it in `WORDS` and in the fake Najiz
  (`api/test/fake-najiz.ts`).
- Cities typed in English on the case page are changed to their Arabic names
  for Najiz's list (`cityInArabic`); a city not in that list stops the run
  with a message to write it in Arabic. Countries use their Arabic names.
- The bank chosen on Najiz must be written as Najiz lists it; otherwise the run
  stops with "not in the Najiz list".

## Status checks (5.5)

The robot follows section C: it opens "التنفيذ", types the request number in
"رقم الطلب", presses "بحث", opens the request and reads "حالة الطلب" and
"الدائرة". One Nafath approval covers every request in the round.

Statuses are kept exactly as Najiz writes them. The dashboard explains two of
them (Sal, 11 November 2026):

| On Najiz | What the client reads |
|---|---|
| قيد المعالجة | Najiz is reviewing the request. Nothing to do yet. |
| قيد التنفيذ | The court accepted the request and is carrying it out. |

Any other status is shown as Najiz writes it, with no explanation added.
