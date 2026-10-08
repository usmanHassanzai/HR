#!/usr/bin/env node
/**
 * Current attendance, office, Wi-Fi, shift, and automatic-attendance guide.
 * Facts only from the rules that are running. Run: npm run docs:attendance-guide
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { jsPDF } from 'jspdf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'downloads', 'Scorr-Attendance-Guide.pdf');

const M = 16;
const W = 210;
const H = 297;
const LINE = 5.15;
const MAX_W = W - M * 2;
const FOOTER_Y = H - 10;

const doc = new jsPDF({ unit: 'mm', format: 'a4' });
let y = 18;
let pageNum = 1;

function newPage() {
  doc.addPage();
  pageNum += 1;
  y = M + 6;
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, W, 14, 'F');
  doc.setDrawColor(226, 232, 240);
  doc.line(0, 14, W, 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(13, 148, 136);
  doc.text('SCORR', M, 9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text('Attendance guide', M + 18, 9);
  doc.text('8 October 2026', W - M, 9, { align: 'right' });
}

function drawFooter() {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(`Page ${pageNum}`, W / 2, FOOTER_Y, { align: 'center' });
  doc.text('Scorr attendance · current rules', M, FOOTER_Y);
}

function ensure(h = LINE) {
  if (y + h > FOOTER_Y - 4) {
    drawFooter();
    newPage();
  }
}

function title(text) {
  ensure(14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 23, 42);
  doc.text(text, M, y);
  y += 7;
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.6);
  doc.line(M, y, M + 42, y);
  y += 6;
}

function h2(text) {
  ensure(9);
  y += 1.2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(13, 148, 136);
  doc.text(text, M, y);
  y += 6;
}

function para(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.7);
  doc.setTextColor(51, 65, 85);
  for (const line of doc.splitTextToSize(text, MAX_W)) {
    ensure();
    doc.text(line, M, y);
    y += LINE;
  }
  y += 1.6;
}

function bullet(text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.7);
  doc.setTextColor(51, 65, 85);
  const lines = doc.splitTextToSize(text, MAX_W - 6);
  lines.forEach((line, i) => {
    ensure();
    doc.text(i === 0 ? `•  ${line}` : `    ${line}`, M + 1, y);
    y += LINE;
  });
}

function note(text) {
  const lines = doc.splitTextToSize(text, MAX_W - 8);
  const boxH = lines.length * LINE + 6;
  ensure(boxH + 2);
  doc.setFillColor(240, 253, 250);
  doc.setDrawColor(13, 148, 136);
  doc.setLineWidth(0.35);
  doc.roundedRect(M, y - 3, MAX_W, boxH, 1.5, 1.5, 'FD');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.2);
  doc.setTextColor(15, 118, 110);
  let ty = y + 2;
  for (const line of lines) {
    doc.text(line, M + 4, ty);
    ty += LINE;
  }
  y += boxH + 2;
}

// Cover
doc.setFillColor(15, 23, 42);
doc.rect(0, 0, W, 78, 'F');
doc.setFillColor(13, 148, 136);
doc.rect(0, 78, W, 2.2, 'F');
doc.setFont('helvetica', 'bold');
doc.setFontSize(11);
doc.setTextColor(45, 212, 191);
doc.text('SCORR', M, 28);
doc.setFontSize(22);
doc.setTextColor(255, 255, 255);
doc.text('Attendance guide', M, 42);
doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(203, 213, 225);
doc.text('Offices, location, Wi-Fi, shifts, and automatic attendance', M, 52);
doc.setFontSize(9);
doc.text('Current rules as of 8 October 2026  ·  scorr.walfia.ai', M, 64);

y = 92;
para('This guide explains only the attendance that is running now: office location, office Wi-Fi, shifts, check-in, check-out, history, and automatic attendance on the phone and on the laptop. It does not cover leave totals, KPIs, rewards, or sign-in.');

h2('1. Who this applies to');
para('Employees, managers, and HR follow the same automatic check-in and check-out rules. Admin and HR set the offices, the Wi-Fi networks, and the company shifts. A manager can set shifts for their own team.');
para('Automatic attendance runs on the Android app, the iPhone or iPad app, the iPhone or iPad Add to Home Screen app, and the Windows and Linux desktop app. A normal browser tab is not an automatic-attendance device.');
para('Each person must be assigned an active office, and must have a shift that covers the current time. The company switch and the person’s own switch must both be on: one pair for the phone, and a separate pair for the laptop. If either switch for that device is off, that device does not track.');

h2('2. The office');
para('Admin and HR open Office & Attendance. There are three steps: create the office, assign people, and review saved offices. The same office is used on the website, the desktop app, and the phone.');
para('An office zone stores:');
bullet('Name.');
bullet('Address, optional.');
bullet('Latitude and longitude of the office pin.');
bullet('Check-in radius in meters. The form allows 30 to 2000. A new office starts at 150 meters.');
bullet('Whether the zone is active. An inactive zone is not used.');
bullet('A default time zone, used as a starting value when a shift is created.');
bullet('Optional extra display time zones, entered as time-zone names separated by commas.');
para('The office form no longer offers GPS only or Wi-Fi only. Check-in uses both: the public IP must match an active office Wi-Fi, and a GPS reading (accuracy 100 m or better, not a mock location) must be inside the saved radius. Either one alone does not check anyone in.');
para('You can drop the pin from the live location on the map, or type the latitude and longitude. Saving an office updates the pin that assigned people use.');

h2('3. Radius and GPS');
para('Distance is the straight-line distance from the phone or laptop reading to the saved office pin.');
bullet('A GPS reading is usable when it has a latitude and longitude, and its accuracy is 100 meters or better. A reading with no accuracy figure is still treated as usable. A reading worse than 100 meters is ignored. It does not check anyone in or out.');
bullet('Inside the office means the usable reading is at or inside the saved radius.');
bullet('Outside the office means the usable reading is farther than the saved radius.');
bullet('The same radius is used for coming in and for going out. Accuracy is not added onto the radius, and there is no extra exit buffer.');
para('A location the phone reports as a mock location is rejected. It does not check anyone in or out.');

h2('4. Office Wi-Fi');
para('Each office can store several Wi-Fi networks. A person matches if they are on any active network for their assigned office. Inactive networks are ignored.');
para('Each network stores:');
bullet('A label, such as Main floor.');
bullet('The Wi-Fi name (SSID).');
bullet('Router IDs (BSSIDs), optional, separated by commas.');
bullet('One or more public IP addresses or CIDR ranges. IPv4 and IPv6 are both accepted. This field is required when the row has a label, a Wi-Fi name, or a router ID.');
bullet('An Active checkbox.');
para('How a device is matched:');
bullet('The public IP is checked against every active network on that office.');
bullet('A laptop or desktop usually cannot read the router ID. If its public IP is inside a saved office network, that is enough. It is on office Wi-Fi.');
bullet('If the phone sends a router ID and that ID matches a network whose IP also matches, that network is used.');
bullet('If the public IP matches an office network but the router ID does not match a row (another band, or a randomized address), the first network with that IP is still accepted.');
bullet('A Wi-Fi name alone, when the public IP is not an office IP, is rejected. Copying the office Wi-Fi name on another internet connection does not count.');
para('Use current Wi-Fi fills a row from the network this computer is on. Test office Wi-Fi checks whether the current connection matches a saved network. You can add as many networks as the office uses. Being on any one of them counts.');

h2('5. Who is assigned to the office');
para('After the office is saved, assign it. You can assign one person, assign every employee, manager, and HR at once, or assign a manager so that manager’s team uses that office.');
para('A personal assignment overrides the office inherited from the manager. Removing an assignment takes that person off that office. Automatic attendance uses the person’s assigned active office. If nobody is assigned, the device is not tracked.');

h2('6. Shifts, and the two clocks');
para('A shift has a name, a start time, an end time, the days it runs, a time zone, and an overnight flag. New shifts start as Monday to Friday. Days are Monday = 1 through Sunday = 7. If the end time is not after the start time, turn on overnight. Saving or assigning a shift emails the people on it.');
para('One shift stores more than one clock. The phone clock is Mobile time. The laptop clock is Desktop time. They are the same working period written in two time zones. You can add up to three extra clocks. The first extra clock is the laptop clock. Each extra clock must be the same moment as the phone clock; the form converts the times when you pick the other time zone. If the times are not the same moment, the shift will not save.');
para('There is a button, Use Pakistan phone + US laptop times. It fills the phone clock as Asia/Karachi, 6:00 PM to 3:00 AM, marks the shift overnight, and fills the laptop clock as the same hours in America/Chicago (about 8:00 AM to 5:00 PM). Those are starting values. You can change the time zones and the hours, as long as every extra clock stays the same moment as the phone clock.');
para('The shift is open when any saved clock covers the current time. The end used to close the day is the latest end among those clocks. An overnight clock belongs to the date it started in that clock’s time zone. If the company has no time zone saved, Asia/Karachi is used only to look up which shift applies today. Each clock then uses its own time zone.');

h2('7. When attendance is allowed to run');
para('Automatic attendance runs from 1 hour before the shift start until 1 hour after the shift end. That hour is on whichever clock is covering now. Outside that window the event is refused and tracking stops until the next window.');
para('An event older than 15 minutes is refused. The same device repeating the same event at the same office inside 5 minutes is ignored, except a heartbeat and except Test now. Test now is a ping, and a ping always runs the presence check.');
para('After the shift has ended, a new automatic check-in is blocked. Manual Clock in is also blocked after the shift has ended.');

h2('8. Setting up automatic attendance');
para('Phone setup, on Android and on iPhone or iPad, including Add to Home Screen:');
bullet('Read why location is needed.');
bullet('Confirm the account has a company, an office zone, and a shift.');
bullet('Allow location. On Android that is while using the app, then all the time. On the iPhone app it is While Using, then Always. On Add to Home Screen, allow location for that Home Screen app.');
bullet('Allow notifications, so check-in and check-out notices can appear.');
bullet('On Android, set the battery use to unrestricted so background check-in keeps running.');
bullet('Register this phone. The device token does not expire. It stays on the phone until automatic attendance is turned off.');
para('The Android app sends a location check about every 5 minutes while its location service is running.');
para('Add to Home Screen on iPhone or iPad is registered as an iOS phone. While that app is open it watches location and sends a check about every 60 seconds, and it sends a fresh location as soon as you return to it. iOS suspends a Home Screen app in the background, so it cannot keep a background fence the way the Android app does. Opening Scorr again sends the current location immediately.');
para('Laptop setup, on the Windows or Linux desktop app:');
bullet('Confirm the account, office zone, and shift.');
bullet('Allow Scorr to start when the computer starts.');
bullet('Check the office network and location. Check-in needs the computer’s public IP on a saved office network and a GPS reading inside the office radius.');
bullet('Register this laptop.');
para('When the desktop app opens it sends power on, then a heartbeat every 5 minutes. Sleep, shutdown, and quit send power off. Power off does not check the person out. Test now sends a ping.');
para('Turning automatic attendance off on that phone or laptop revokes it for that device and stops its checks.');

h2('9. Check-in');
para('During the shift window, a person is checked in when they arrive. The record is Present and it is approved automatically. No one has to approve a check-in.');
bullet('Phone and laptop check in only when both are true at the same time: the public IP matches an active office network, and a usable GPS reading (accuracy 100 m or better, not a mock location) is at or inside the saved radius. GPS inside the radius without office Wi-Fi does not check in. Office Wi-Fi without that GPS reading does not check in.');
bullet('If only the Wi-Fi matches, the reason is: Not on office Wi-Fi. If the Wi-Fi matches but the GPS reading is missing, weak, or outside the radius, the reason is: Not inside the office radius.');
bullet('Laptop: GPS is often missing or weak. If there is no usable GPS reading, the laptop is not checked in. The app requests a fresh location and tries the check-in again.');
para('The saved source is auto_wifi on the phone and auto_laptop on the laptop. Manual Clock in is stored as manual and uses the same both-required rule. The saved note names the office, the Wi-Fi label, and the distance from the office pin.');
para('If they are already checked in and a visit is still open, the result is already checked in. It does not open a second visit and it does not check them out.');
para('Test now does not check in unless the laptop is on office Wi-Fi and a fresh GPS reading is inside the office radius. If the Wi-Fi does not match, the card says: Not on office Wi-Fi. If the location is missing or outside the radius, the card says: Not inside the office radius.');
para('A person can leave and come back during the same shift. Each return opens another visit. The minutes of the visits are added. The time away is not counted.');
para('Work-from-home is exempt from the office Wi-Fi and radius check-in rule. That is a person whose work mode is remote, or a remote or hybrid day marked by Admin or HR. Automatic attendance does not check them in from the office network. A person set to remote is not tracked.');

h2('10. Check-out');
note('During the shift, an employee, manager, or HR stays checked in while they are inside the office radius. A Wi-Fi drop alone never checks them out. They are checked out on the first usable GPS reading that is outside that radius, even if the device is still on office Wi-Fi.');
para('One outside reading is enough on the phone and on the laptop. A usable check-out reading has accuracy of 50 meters or better. Distance is compared with the saved office radius. There is no extra buffer. The check-out time saved on the visit is the time of that outside reading.');
para('Check-out runs from the shift start until 1 hour after the shift ends. It does not run during the hour before the shift starts.');
para('Android uses a geofence exit for the office zone, and also takes a location check about every 20 seconds during the shift window. That needs background location and battery use set to Unrestricted.');
para('The iPhone app uses region monitoring (a geofence exit) with Always location.');
para('The iPhone Home Screen app cannot run in the background. It checks when you open it, and every 60 seconds while it stays open.');
para('Another enrolled device that still looks present does not delay check-out. An outside reading on any device checks the person out and marks all of their devices as not present.');
para('When they come back inside the radius and are on office Wi-Fi during the shift, they are checked in again on a new visit. Visit minutes are added. Time away is not counted.');
para('When the latest shift clock ends, the open visit is closed at that end time. The note says the shift ended. That close does not depend on Wi-Fi or on the radius. Manual Clock out also stays available.');

h2('11. What does not check someone out');
bullet('Logging out of Scorr.');
bullet('The phone going quiet, or no location arriving. A missing ping is not treated as leaving.');
bullet('Disconnecting from Wi-Fi by itself.');
bullet('Turning the laptop off, putting it to sleep, or quitting the desktop app.');
bullet('Test now or a heartbeat on a laptop that is not on office Wi-Fi, when the person is already checked in. The open visit stays open.');
bullet('A GPS reading that is missing, or worse than 50 meters, for check-out.');
bullet('Being inside the radius.');
bullet('Opening attendance history. Opening the page does not close anyone.');
para('Being on office Wi-Fi does not keep someone checked in once a usable GPS reading is outside the radius.');

h2('12. Manual Clock in and Clock out');
para('The Clock in and Clock out buttons stay available.');
bullet('Clock in uses the same rule as automatic check-in: office Wi-Fi and a usable GPS reading inside the office radius. If the Wi-Fi does not match, it says Not on office Wi-Fi. If the location is missing or outside the radius, it says Not inside the office radius. Work-from-home members are exempt. If they are already in, it does not start another visit. The source is manual.');
bullet('Clock out checks them out even when they are still inside the office and still on office Wi-Fi. Use it when they need to leave the shift early. Automatic attendance will not do that for them.');
para('While a visit is open, the attendance page shows: You are still present in the office and working. After a check-out, if the shift is still running, coming back can check them in again. After the shift has ended, it will not.');

h2('13. History and duration');
para('Each day can hold several visits. The day clock-in is the first visit. The day clock-out is the last real clock-out. If any visit is still open, the day has no clock-out.');
para('History also treats the day as still open when a device is still marked present, that presence is within the last 12 hours, and it falls from 2 minutes before the clock-in to 20 hours after it.');
para('On the history card:');
bullet('No clock-out means Still present in office.');
bullet('The duration keeps moving and ends with “still working”.');
bullet('If they left and checked in again, the duration is the closed visits plus the open visit. The gap between visits is not added. The number keeps growing from that total while they remain in.');
bullet('A real clock-out stops the duration at that clock-out. It does not keep counting.');
para('Times on the screen use the clock of the computer or phone you are looking at. An admin or manager history list reloads about every 20 seconds. An open duration on a card updates about every 30 seconds.');

h2('14. Notifications');
para('A check-out notice stores the real instant of the check-out. When you read it, the time in the sentence is shown on the same clock as the visit list on that device. A notice that was written from the phone’s time zone is rewritten to the clock you are using, so the notice and the attendance row show the same time.');
para('An “Active shift updated” notice shows the shift’s own label and hours. That label is not rewritten into the viewer’s clock.');

h2('15. Remote and hybrid days');
para('On the attendance page, admin and HR can mark remote and hybrid staff present or absent for a work-from-home day. That mark is saved in their attendance history. People whose work mode is office still use the office radius and office Wi-Fi. A person set to remote is not tracked by automatic attendance.');

h2('16. The rule in one place');
bullet('Set the office pin, the radius, and every office Wi-Fi, including each public IP.');
bullet('Assign that office to the person.');
bullet('Save the shift with the phone clock and the laptop clock. The shift is open if either clock covers now, from 1 hour before start until 1 hour after end.');
bullet('Set up the phone, the Home Screen app, or the laptop once.');
bullet('Check in only when they are on office Wi-Fi and a usable GPS reading is inside the radius, during that window. Work-from-home members are exempt from this rule.');
bullet('Stay checked in while they remain inside the radius, whether or not Wi-Fi is connected.');
bullet('Check out on the first GPS reading that is outside the saved radius, with accuracy 50 meters or better, even on office Wi-Fi. That runs from shift start until 1 hour after shift end. The saved time is the time of that reading. All of their devices are then marked not present.');
bullet('When they return inside the radius and on office Wi-Fi during the shift, open a new visit.');
bullet('Also check out when the shift ends, or when they press Clock out.');
bullet('Do not check out for logout, silence, a Wi-Fi drop, or the laptop powering off.');

para('This describes the attendance rules running on 9 October 2026.');

drawFooter();

const buf = Buffer.from(doc.output('arraybuffer'));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log(`Wrote ${OUT}`);
console.log(`Pages: ${doc.getNumberOfPages()}  Size: ${(buf.length / 1024).toFixed(0)} KB`);
