document.addEventListener("DOMContentLoaded", function() {
	// Attach event listener for the Start button
	document.getElementById("startButton").addEventListener("click", function () {
		alert("$$$'$$$$$$$$$$$!");
	});
});

document.addEventListener("DOMContentLoaded", function() {
	// Attach event listener for the Create Project button
	document.getElementById("createProjectButton").addEventListener("click", function () {
		alert("$$$$$$$$$$$$$$$$$!");
	});
});

document.addEventListener("DOMContentLoaded", function() {
	// Attach event listener for the Search button
	document.getElementById("searchButton").addEventListener("click", function () {
		alert("$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$。$$$$$$$$$$$$$$$$$$$$$$$$$$$$。");
	});
});

document.addEventListener("DOMContentLoaded", function() {
    // Function to display a message
    function showMessage(message, isError = false) {
        const messageDiv = document.getElementById("messageDiv");
        messageDiv.innerHTML = message;
        messageDiv.style.color = isError ? "red" : "green";
    }
	
    // Form submission
    document.getElementById("contactForm").addEventListener("submit", function(event) {
        event.preventDefault();
        const name = document.getElementById("name").value;
        const email = document.getElementById("email").value;
        const message = document.getElementById("message").value;

        // Basic email validation using a regular expression
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;

        // Validate name
        if (name.trim() === "") {
            showMessage("$$$$$$$$$$$$$$$$$$$。", true);
            return;
        }

        // Validate email
        if (!emailRegex.test(email)) {
            showMessage("$$$$$$$$$$$$$$$$$$$$$$$$$$$$$。", true);
            return;
        }

        // Validate message
        if (message.trim() === "") {
            showMessage("$$$$$$$$$$$$$$$$$$$。", true);
            return;
        }

        // If all validations pass, display a success message
        showMessage("$$$$$$$$$$$$$$$$$$$$$$$!", false);

        // Reset the form
        document.getElementById("contactForm").reset();
    });
});
